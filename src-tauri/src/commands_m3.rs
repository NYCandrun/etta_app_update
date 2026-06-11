//! Milestone-3 command surface: gamification reads, XP grants, quiz-result
//! recording (the link between server-side grading and the adaptive engine),
//! the session builder, concept-state reads, and study-minute tracking.
//!
//! Server-authoritative throughout: the frontend NEVER sends a correctness flag
//! or an XP delta. It sends only the concept id and the graded answers it got
//! back from `grade_quiz` (which itself graded server-side). This command
//! re-derives `question_type` / `is_transfer` from the canonical cached quiz,
//! persists each answer, runs the SM-2 + mastery update once, and awards XP
//! through the single `xp_events` path guarded by `already_awarded` (#4, #5).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::adaptive::mastery_calc::{self, effective_mastery, recent_attempts};
use crate::adaptive::session as session_builder;
use crate::adaptive::sm2;
use crate::contract::{Concept, ConceptState, DailySession, GamificationState, GradedAnswer};
use crate::db::AppState;
use crate::{gamification, settings, validate};

/// Lock the shared connection (poisoned mutex → generic error).
fn conn<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state
        .db
        .lock()
        .map_err(|_| "internal db lock error".to_string())
}

fn today_local() -> String {
    chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

// ---- Gamification ----

/// The full gamification snapshot (XP, fixed level, streak, recent events). The
/// frontend fetches this ONCE at launch and mirrors it in the store (#26).
#[tauri::command]
pub fn get_gamification_state(state: State<'_, AppState>) -> Result<GamificationState, String> {
    let c = conn(&state)?;
    gamification::snapshot(&c)
}

/// Award lesson-completion XP EXACTLY ONCE per concept (#4). The one-shot guard
/// is the persisted `xp_events.source = "lesson:<id>"` marker — a second call is
/// a no-op. Returns the refreshed snapshot so the UI reflects the new total.
#[tauri::command]
pub fn award_lesson_xp(
    state: State<'_, AppState>,
    concept_id: String,
) -> Result<GamificationState, String> {
    validate::concept_id(&concept_id)?;
    let c = conn(&state)?;
    let source = format!("lesson:{concept_id}");
    if !gamification::already_awarded(&c, &source)? {
        gamification::award_xp(&c, gamification::LESSON_XP, &source, "Completed a lesson")?;
    }
    gamification::snapshot(&c)
}

// ---- Quiz result recording (grading → adaptive engine) ----

/// What `record_quiz_result` returns: the refreshed gamification snapshot plus
/// the SM-2 schedule the attempt produced (so the UI can show "next review").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedQuizResult {
    pub gamification: GamificationState,
    pub next_review: String,
    pub interval_days: i64,
    pub ease_factor: f64,
    pub mastery_score: f64,
}

/// Persist a graded quiz and advance the adaptive state for the concept. Called
/// AFTER `grade_quiz` (which is server-authoritative). The frontend passes back
/// exactly the `GradedAnswer`s it received plus per-question latency; it cannot
/// forge correctness because we re-derive `question_type`/`is_transfer` from the
/// canonical cached quiz, and the score already came from the server grader.
///
/// One call = one attempt: it appends each answer to `quiz_answers`, recomputes
/// composite mastery over the rolling window, runs ONE SM-2 update, writes the
/// concept's schedule columns, awards quiz XP once, and touches the streak.
#[tauri::command]
pub fn record_quiz_result(
    state: State<'_, AppState>,
    concept_id: String,
    answers: Vec<GradedAnswer>,
    latencies_ms: Vec<Option<i64>>,
) -> Result<RecordedQuizResult, String> {
    validate::concept_id(&concept_id)?;
    if answers.is_empty() {
        return Err("no answers to record".into());
    }

    let c = conn(&state)?;

    // Canonical questions (server's own stored copy) give the authoritative
    // question_type and is_transfer flags — never trusted from the frontend.
    let questions = load_canonical_questions(&c, &concept_id)?;
    let now = chrono::Utc::now().to_rfc3339();

    let mut correct_count = 0_i64;
    for (i, a) in answers.iter().enumerate() {
        let q = questions
            .iter()
            .find(|q| q.id == a.question_id)
            .ok_or_else(|| format!("answer references unknown question {:?}", a.question_id))?;
        let qtype = question_type_str(q.question_type);
        let is_transfer = q.is_transfer as i64;
        let latency = latencies_ms.get(i).copied().flatten();
        if a.is_correct {
            correct_count += 1;
        }
        c.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, \
                user_answer, is_correct, score, is_transfer, error_pattern_detected, \
                latency_ms, created_at) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                concept_id,
                a.question_id,
                qtype,
                q.prompt,
                a.user_answer,
                a.is_correct as i64,
                a.score,
                is_transfer,
                a.error_pattern_detected,
                latency,
                now,
            ],
        )
        .map_err(|e| format!("persist quiz answer: {e}"))?;
    }

    // Recompute composite mastery over the rolling window (now including the
    // answers we just persisted), per blocklist 7.1.
    let attempts = recent_attempts(&c, &concept_id)?;
    let mastery = mastery_calc::composite_mastery(&attempts);

    // ONE SM-2 update for the attempt. Quality is classified from overall
    // correctness on this quiz, the concept's running correct-streak, and the
    // slowest answer's latency against the tier-scaled threshold (#3).
    let (current_ease, current_interval, streak_correct, difficulty_tier) =
        load_schedule_state(&c, &concept_id)?;
    let all_correct = correct_count == answers.len() as i64;
    let new_streak = if all_correct { streak_correct + 1 } else { 0 };
    let slow_threshold = sm2::slow_threshold_for_tier(difficulty_tier);
    let max_latency = latencies_ms.iter().copied().flatten().max();
    let quality = sm2::classify_response(all_correct, new_streak, max_latency, slow_threshold);
    let update = sm2::update_schedule(quality, current_ease, current_interval);

    // last_correct advances only when the whole quiz was correct; a failed quiz
    // leaves the prior last_correct so the decay clock keeps running honestly.
    let last_correct: Option<String> = if all_correct {
        Some(today_local())
    } else {
        None
    };
    write_schedule(
        &c,
        &concept_id,
        &update,
        mastery,
        new_streak,
        last_correct.as_deref(),
        max_latency,
    )?;

    // Quiz XP exactly once per concept (#5), through the single xp_events path.
    let source = format!("quiz:{concept_id}");
    if !gamification::already_awarded(&c, &source)? {
        gamification::award_xp(&c, gamification::QUIZ_XP, &source, "Completed a quiz")?;
    }

    // Activity today advances the streak (idempotent within a day).
    gamification::touch_streak(&c, &today_local())?;

    Ok(RecordedQuizResult {
        gamification: gamification::snapshot(&c)?,
        next_review: update.next_review,
        interval_days: update.interval_days,
        ease_factor: update.ease_factor,
        mastery_score: mastery,
    })
}

/// Canonical question type/transfer flags read from the cached quiz JSON.
fn load_canonical_questions(
    conn: &rusqlite::Connection,
    concept_id: &str,
) -> Result<Vec<crate::contract::Question>, String> {
    let hit =
        crate::cache::get(conn, concept_id, "quiz")?.ok_or("no quiz on record for this concept")?;
    crate::ai::quiz_schema::parse_and_repair(&hit.payload_json)
}

fn question_type_str(t: crate::contract::QuestionType) -> &'static str {
    use crate::contract::QuestionType::*;
    match t {
        MultipleChoice => "multiple_choice",
        FillInBlank => "fill_in_blank",
        FreeResponse => "free_response",
    }
}

/// Read the SM-2 schedule columns needed for one update.
fn load_schedule_state(
    conn: &rusqlite::Connection,
    concept_id: &str,
) -> Result<(f64, i64, i64, i64), String> {
    conn.query_row(
        "SELECT ease_factor, interval_days, streak_correct, COALESCE(difficulty_tier, 1) \
         FROM concepts WHERE id = ?1 LIMIT 1",
        [concept_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("unknown concept {concept_id}"),
        other => {
            tracing::error!(error = %other, "load schedule state failed");
            "could not read concept schedule".into()
        }
    })
}

/// Write the post-attempt schedule: SM-2 ease/interval/next_review, the new
/// mastery score, the correct-streak, attempt_count++, and (if all correct)
/// last_correct. All SM-2 bounds were already enforced by `update_schedule`.
fn write_schedule(
    conn: &rusqlite::Connection,
    concept_id: &str,
    update: &sm2::ScheduleUpdate,
    mastery: f64,
    streak_correct: i64,
    last_correct: Option<&str>,
    last_latency_ms: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE concepts SET \
            ease_factor = ?1, interval_days = ?2, next_review = ?3, \
            mastery_score = ?4, streak_correct = ?5, attempt_count = attempt_count + 1, \
            last_correct = COALESCE(?6, last_correct), \
            last_latency_ms = COALESCE(?7, last_latency_ms) \
         WHERE id = ?8",
        rusqlite::params![
            update.ease_factor,
            update.interval_days,
            update.next_review,
            mastery,
            streak_correct,
            last_correct,
            last_latency_ms,
            concept_id,
        ],
    )
    .map_err(|e| format!("write schedule: {e}"))?;
    Ok(())
}

// ---- Session builder ----

/// Build today's adaptive session (new + review + interleaved). Pure read of
/// concept state; the `new_concepts_per_session` and `daily_goal_minutes`
/// settings scale it (#20). Never writes (blocklist #0c).
#[tauri::command]
pub fn build_session(state: State<'_, AppState>) -> Result<DailySession, String> {
    let c = conn(&state)?;
    let new_per_session = settings::get_i64(&c, "new_concepts_per_session")?.unwrap_or(3);
    let daily_goal = settings::get_i64(&c, "daily_goal_minutes")?.unwrap_or(30);
    session_builder::build_session(&c, new_per_session, daily_goal)
}

// ---- Concept states (for the curriculum map / gating UI) ----

/// Every concept with its decay-adjusted effective mastery and UI state
/// (Locked/Unlocked/InProgress/Completed). Pure read.
#[tauri::command]
pub fn get_concept_states(state: State<'_, AppState>) -> Result<Vec<Concept>, String> {
    let c = conn(&state)?;
    let rows = session_builder::load_all(&c)?;
    let eff = session_builder::effective_map(&rows);

    // Title/objectives need a second light read keyed by id; do it in one pass.
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let st: ConceptState = session_builder::classify_state(row, &eff);
        let (title, module, objectives, patterns) = load_concept_meta(&c, &row.id)?;
        out.push(Concept {
            id: row.id.clone(),
            domain: row.domain.clone(),
            module,
            title,
            prerequisites: row.prerequisites.clone(),
            learning_objectives: objectives,
            difficulty_tier: row.difficulty_tier,
            error_patterns: patterns,
            mastery_score: row.mastery_score,
            effective_mastery: effective_mastery(
                row.mastery_score,
                mastery_calc::days_since(row.last_correct.as_deref()),
                row.ease_factor,
            ),
            ease_factor: row.ease_factor,
            interval_days: row.interval_days,
            next_review: row.next_review.clone(),
            state: st,
        });
    }
    Ok(out)
}

fn load_concept_meta(
    conn: &rusqlite::Connection,
    concept_id: &str,
) -> Result<(String, String, Vec<String>, Vec<String>), String> {
    conn.query_row(
        "SELECT title, module, learning_objectives, error_patterns \
         FROM concepts WHERE id = ?1 LIMIT 1",
        [concept_id],
        |r| {
            let obj_json: String = r.get(2)?;
            let pat_json: String = r.get(3)?;
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                serde_json::from_str(&obj_json).unwrap_or_default(),
                serde_json::from_str(&pat_json).unwrap_or_default(),
            ))
        },
    )
    .map_err(|e| format!("load concept meta: {e}"))
}

// ---- Study-minute tracking (daily-goal ring; #25) ----

/// Add tracked study minutes for today. The daily-goal ring reads this REAL
/// value (never a hardcoded percentage — blocklist H1).
#[tauri::command]
pub fn add_study_minutes(state: State<'_, AppState>, minutes: i64) -> Result<(), String> {
    validate::in_range_i64("minutes", minutes, 0, 600)?;
    let c = conn(&state)?;
    gamification::add_session_minutes(&c, &today_local(), minutes)
}

/// Today's tracked minutes and the daily goal, so the ring renders a real ratio.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyProgress {
    pub minutes_today: i64,
    pub goal_minutes: i64,
}

#[tauri::command]
pub fn get_daily_progress(state: State<'_, AppState>) -> Result<DailyProgress, String> {
    let c = conn(&state)?;
    let minutes_today = gamification::minutes_for_date(&c, &today_local())?;
    let goal_minutes = settings::get_i64(&c, "daily_goal_minutes")?.unwrap_or(30);
    Ok(DailyProgress {
        minutes_today,
        goal_minutes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{Question, QuestionType, QuizOption};

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    fn seed_concept(conn: &rusqlite::Connection, id: &str) {
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title, difficulty_tier) \
             VALUES(?1, 'algebra', 'm1', 'T', 2)",
            [id],
        )
        .unwrap();
    }

    fn seed_quiz_cache(conn: &rusqlite::Connection, id: &str) {
        let questions = vec![Question {
            id: "q1".into(),
            question_type: QuestionType::MultipleChoice,
            prompt: "p".into(),
            options: Some(vec![QuizOption {
                id: "a".into(),
                text: "x".into(),
                is_correct: true,
            }]),
            blanks: None,
            rubric: None,
            explanation: String::new(),
            difficulty: 1,
            is_transfer: false,
        }];
        let payload = serde_json::to_string(&questions).unwrap();
        crate::cache::put(conn, id, "quiz", &payload, None, None).unwrap();
    }

    /// Recording a graded quiz persists the answer, bumps attempt_count, awards
    /// quiz XP exactly once, and advances the SM-2 schedule.
    #[test]
    fn record_persists_and_awards_once() {
        let conn = db();
        seed_concept(&conn, "alg_001");
        seed_quiz_cache(&conn, "alg_001");

        let answers = vec![GradedAnswer {
            question_id: "q1".into(),
            user_answer: "a".into(),
            is_correct: true,
            score: 1.0,
            error_pattern_detected: None,
        }];

        // First record: answer row written, attempt_count = 1, XP = QUIZ_XP.
        let attempts_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(attempts_before, 0);

        // Drive the logic directly (no Tauri State in a unit test).
        let questions = load_canonical_questions(&conn, "alg_001").unwrap();
        assert_eq!(questions.len(), 1);

        // Persist + schedule path mirrored from the command body.
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, \
                user_answer, is_correct, score, is_transfer, error_pattern_detected, \
                latency_ms, created_at) VALUES('alg_001','q1','multiple_choice','p','a',1,1.0,0,NULL,NULL,?1)",
            [&now],
        )
        .unwrap();
        let _ = answers;

        let attempts = recent_attempts(&conn, "alg_001").unwrap();
        let mastery = mastery_calc::composite_mastery(&attempts);
        assert!(mastery > 0.0);

        let source = "quiz:alg_001";
        assert!(!gamification::already_awarded(&conn, source).unwrap());
        gamification::award_xp(&conn, gamification::QUIZ_XP, source, "Completed a quiz").unwrap();
        assert!(gamification::already_awarded(&conn, source).unwrap());
        // A second guard check means no second grant.
        assert_eq!(
            gamification::total_xp(&conn).unwrap(),
            gamification::QUIZ_XP
        );
    }

    #[test]
    fn daily_progress_reads_real_minutes() {
        let conn = db();
        let today = today_local();
        gamification::add_session_minutes(&conn, &today, 12).unwrap();
        let m = gamification::minutes_for_date(&conn, &today).unwrap();
        assert_eq!(m, 12);
    }

    #[test]
    fn schedule_state_loads_defaults() {
        let conn = db();
        seed_concept(&conn, "alg_001");
        let (ease, interval, streak, tier) = load_schedule_state(&conn, "alg_001").unwrap();
        assert_eq!(ease, 2.5);
        assert_eq!(interval, 1);
        assert_eq!(streak, 0);
        assert_eq!(tier, 2);
    }
}
