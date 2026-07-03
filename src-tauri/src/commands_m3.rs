//! Milestone-3 command surface: gamification reads, XP grants, the quiz
//! persist path (the link between server-side grading and the adaptive
//! engine), the session builder, concept-state reads, and study-minute
//! tracking.
//!
//! Server-authoritative throughout: the frontend NEVER sends a correctness
//! flag or an XP delta. Graded answers never round-trip through the webview —
//! `grade_and_record_quiz` (commands_ai) grades AND persists in one command,
//! and a persist retry (`retry_persist`) replays the SERVER-held graded result
//! from `PendingPersists`. The persist path receives the CANONICAL questions
//! from its caller (the same loaded instance grading used — it never re-reads
//! the cache, so grade and persist can never see two different quiz rows),
//! derives `question_type` / `is_transfer` from them, persists each answer,
//! runs the SM-2 + mastery update once, and awards XP through the single
//! `xp_events` path guarded by `already_awarded` (#4, #5).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::State;

use crate::adaptive::mastery_calc::{self, recent_attempts};
use crate::adaptive::session as session_builder;
use crate::adaptive::sm2;
use crate::contract::{
    Concept, ConceptState, DailyProgress, DailySession, GamificationState, GradedAnswer, Question,
    QuizOutcome,
};
use crate::db::AppState;
use crate::{gamification, settings, validate};

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
    let c = state.conn()?;
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
    let c = state.conn()?;
    award_lesson_xp_into_conn(&c, &concept_id)
}

/// Body of `award_lesson_xp` against a plain connection (testable).
pub(crate) fn award_lesson_xp_into_conn(
    conn: &rusqlite::Connection,
    concept_id: &str,
) -> Result<GamificationState, String> {
    let source = format!("lesson:{concept_id}");
    if !gamification::already_awarded(conn, &source)? {
        gamification::award_xp(conn, gamification::LESSON_XP, &source, "Completed a lesson")?;
    }
    // R13: completing a lesson is real activity — it advances the daily
    // streak like a quiz does. `touch_streak` is idempotent within a day, so
    // exactly-once-per-day holds no matter how many sources fire.
    gamification::touch_streak(conn, &today_local())?;
    gamification::snapshot(conn)
}

// ---- Quiz persist path (grading → adaptive engine) ----

/// Persist one server-graded quiz atomically: opens the transaction, runs the
/// full `record_into_conn` write sequence, commits. Returns the refreshed
/// gamification snapshot. Shared by `grade_and_record_quiz` (commands_ai) and
/// `retry_persist` — the ONLY two entry points to the persist path; both hand
/// it SERVER-produced GradedAnswers exclusively, plus the CANONICAL questions
/// the answers were graded against (the persist path never re-reads the
/// cache, so grade and persist always use the same loaded instance).
///
/// `quiz_row_id` is the graded quiz's own cache row (the nonce): on success
/// it is deleted so a retake regenerates (R5) — ONLY that row, never every
/// row for the concept (a concurrently generated quiz another window is
/// answering must survive). The retry path passes None: its row was already
/// deleted when the pending result was stashed.
pub(crate) fn persist_graded(
    state: &AppState,
    concept_id: &str,
    questions: &[Question],
    answers: &[GradedAnswer],
    latencies_ms: &[Option<i64>],
    quiz_row_id: Option<i64>,
) -> Result<GamificationState, String> {
    let mut c = state.conn()?;
    // One attempt = one atomic unit: every write in `record_into_conn` (answer
    // inserts, schedule UPDATE, XP grant, streak) commits together or rolls back
    // together. Without this, a mid-sequence failure left partial state and a
    // client retry would double-insert answer rows, inflating the rolling window
    // and skewing mastery.
    let tx = c
        .transaction()
        .map_err(|e| crate::util::internal_error("start saving your quiz result", e))?;
    let result = record_into_conn(&tx, concept_id, questions, answers, latencies_ms)?;
    tx.commit()
        .map_err(|e| crate::util::internal_error("save your quiz result", e))?;
    // R5: the quiz is recorded and its answer key is about to be shown on the
    // review screen — drop the graded quiz's OWN cache row so a retake
    // REGENERATES instead of replaying a quiz whose answers were just
    // revealed. Best-effort: the result is already committed; a failed delete
    // only risks a replayed retake, never a lost result.
    if let Some(row_id) = quiz_row_id {
        if let Err(e) = crate::cache::delete_by_id(&c, row_id) {
            tracing::warn!(error = %e, concept_id, row_id, "post-record quiz cache delete failed");
        }
    }
    Ok(result)
}

/// The full quiz-result write sequence against one connection. Run inside a
/// transaction by the caller so all writes are atomic: returning `Err` from any
/// step aborts before commit and leaves no partial state.
///
/// The answers are always SERVER-produced (grading and recording are fused in
/// `grade_and_record_quiz`; the retry path replays a server-held copy), and
/// the caller has already validated them as an exact permutation of the
/// canonical question ids. `questions` is the SAME canonical instance the
/// answers were graded against — passed in, never re-read from the cache, so
/// this path can never persist a different quiz's question_type/is_transfer/
/// prompt than the one that was graded. The unknown-id and duplicate-id
/// checks here are defense in depth on the same transaction.
pub(crate) fn record_into_conn(
    conn: &rusqlite::Connection,
    concept_id: &str,
    questions: &[Question],
    answers: &[GradedAnswer],
    latencies_ms: &[Option<i64>],
) -> Result<GamificationState, String> {
    let now = chrono::Utc::now().to_rfc3339();

    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut correct_count = 0_i64;
    for (i, a) in answers.iter().enumerate() {
        let q = questions
            .iter()
            .find(|q| q.id == a.question_id)
            .ok_or_else(|| format!("answer references unknown question {:?}", a.question_id))?;
        if !seen_ids.insert(a.question_id.as_str()) {
            // Duplicate rows would occupy rolling-window slots and skew
            // mastery/all_correct (H9) — abort the whole transaction.
            return Err(format!(
                "question {:?} was answered more than once — please submit each question exactly once",
                a.question_id
            ));
        }
        let qtype = question_type_str(q.question_type);
        let is_transfer = q.is_transfer as i64;
        let latency = latencies_ms.get(i).copied().flatten();
        if a.is_correct {
            correct_count += 1;
        }
        conn.execute(
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
        .map_err(|e| crate::util::internal_error("save a quiz answer", e))?;
    }

    // Recompute composite mastery over the rolling window (now including the
    // answers we just persisted), per blocklist 7.1.
    let attempts = recent_attempts(conn, concept_id)?;
    let mastery = mastery_calc::composite_mastery(&attempts);

    // ONE SM-2 update for the attempt. Quality is classified from overall
    // correctness on this quiz, the concept's running correct-streak, and the
    // slowest answer's latency against the tier-scaled threshold (#3).
    let (current_ease, current_interval, streak_correct, difficulty_tier) =
        load_schedule_state(conn, concept_id)?;
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
        conn,
        concept_id,
        &update,
        mastery,
        new_streak,
        last_correct.as_deref(),
        max_latency,
    )?;

    // Quiz XP exactly once per concept (#5), through the single xp_events path.
    let source = format!("quiz:{concept_id}");
    if !gamification::already_awarded(conn, &source)? {
        gamification::award_xp(conn, gamification::QUIZ_XP, &source, "Completed a quiz")?;
    }

    // Activity today advances the streak (idempotent within a day).
    gamification::touch_streak(conn, &today_local())?;

    gamification::snapshot(conn)
}

// ---- Pending persists (grade succeeded, persist failed) ----

/// Server-held graded results whose persist step failed. `grade_and_record_quiz`
/// stashes the graded quiz here and returns `recorded: false` plus the token;
/// `retry_persist(token)` replays the persist from THIS copy — the frontend
/// never sends graded answers back, so the retry path opens no forgery hole.
///
/// In-memory only (Tauri-managed state): an app restart drops pending entries,
/// which is honest — the learner saw the score, and the quiz can be retaken.
#[derive(Default)]
pub struct PendingPersists {
    entries: Mutex<HashMap<String, PendingQuiz>>,
    counter: AtomicU64,
}

/// One graded-but-unpersisted quiz, exactly as the grader produced it.
/// `questions` is a SNAPSHOT of the canonical questions taken at stash time:
/// the retry replays the persist from this copy alone and never re-reads the
/// content cache — so a later persist (or the revealed-quiz cleanup) deleting
/// cache rows can never strand or corrupt a pending result.
#[derive(Debug, Clone)]
pub struct PendingQuiz {
    pub concept_id: String,
    pub questions: Vec<Question>,
    pub graded: Vec<GradedAnswer>,
    pub latencies_ms: Vec<Option<i64>>,
    pub final_score: f64,
    pub all_correct: bool,
}

impl PendingPersists {
    /// Stash a graded quiz and return its opaque one-shot token.
    pub fn stash(&self, entry: PendingQuiz) -> Result<String, String> {
        let token = self.make_token(&entry.concept_id);
        self.entries
            .lock()
            .map_err(|_| "internal state lock error".to_string())?
            .insert(token.clone(), entry);
        Ok(token)
    }

    /// Take (remove) a pending entry — one-shot; a second take returns None.
    fn take(&self, token: &str) -> Result<Option<PendingQuiz>, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "internal state lock error".to_string())?
            .remove(token))
    }

    /// Re-stash an entry under the SAME token after a failed retry, so the
    /// frontend's retry affordance keeps working with the token it holds.
    fn put_back(&self, token: &str, entry: PendingQuiz) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "internal state lock error".to_string())?
            .insert(token.to_string(), entry);
        Ok(())
    }

    /// Opaque token: sha256 over a process-lifetime counter, the current time,
    /// and the concept id — UUID-like without a new dependency. Unguessability
    /// is not load-bearing (the token only re-persists a result this same
    /// client already earned); uniqueness is, and the counter guarantees it.
    fn make_token(&self, concept_id: &str) -> String {
        use sha2::{Digest, Sha256};
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut h = Sha256::new();
        h.update(n.to_le_bytes());
        h.update(nanos.to_le_bytes());
        h.update(concept_id.as_bytes());
        h.finalize()
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

/// Retry persisting a graded quiz whose original persist failed. Replays the
/// SERVER-held graded result (never client-supplied data) inside the same
/// atomic `record_into_conn` path — grading is never repeated, so no model
/// call is re-bought, and the canonical questions come from the stash-time
/// SNAPSHOT (never the cache, whose row was already consumed). On another
/// persist failure the entry is re-stashed under the same token and
/// `recorded: false` is returned again.
#[tauri::command]
pub fn retry_persist(
    state: State<'_, AppState>,
    pending: State<'_, PendingPersists>,
    token: String,
) -> Result<QuizOutcome, String> {
    retry_persist_inner(&state, &pending, token)
}

/// The testable body of `retry_persist` (the command wrapper only unwraps
/// Tauri state).
pub(crate) fn retry_persist_inner(
    state: &AppState,
    pending: &PendingPersists,
    token: String,
) -> Result<QuizOutcome, String> {
    let Some(entry) = pending.take(&token)? else {
        return Err("nothing to retry — this result was already saved or the app was restarted".into());
    };

    match persist_graded(
        state,
        &entry.concept_id,
        &entry.questions,
        &entry.graded,
        &entry.latencies_ms,
        None,
    ) {
        Ok(gamification) => Ok(QuizOutcome {
            per_question: entry.graded,
            final_score: entry.final_score,
            all_correct: entry.all_correct,
            recorded: true,
            retry_token: None,
            gamification: Some(gamification),
        }),
        Err(e) => {
            tracing::error!(error = %e, concept_id = %entry.concept_id, "retry persist failed");
            let outcome = QuizOutcome {
                per_question: entry.graded.clone(),
                final_score: entry.final_score,
                all_correct: entry.all_correct,
                recorded: false,
                retry_token: Some(token.clone()),
                gamification: None,
            };
            pending.put_back(&token, entry)?;
            Ok(outcome)
        }
    }
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
    .map_err(|e| crate::util::internal_error("update the review schedule", e))?;
    Ok(())
}

// ---- Session builder ----

/// Build today's adaptive session (new + review + interleaved). Pure read of
/// concept state; the `new_concepts_per_session` and `daily_goal_minutes`
/// settings scale it (#20). Never writes (blocklist #0c).
#[tauri::command]
pub fn build_session(state: State<'_, AppState>) -> Result<DailySession, String> {
    let c = state.conn()?;
    let new_per_session = settings::new_concepts_per_session(&c)?;
    let daily_goal = settings::daily_goal_minutes(&c)?;
    session_builder::build_session(&c, new_per_session, daily_goal)
}

// ---- Concept states (for the curriculum map / gating UI) ----

/// Every concept with its decay-adjusted effective mastery and UI state
/// (Locked/Unlocked/InProgress/Completed). Pure read.
#[tauri::command]
pub fn get_concept_states(state: State<'_, AppState>) -> Result<Vec<Concept>, String> {
    let c = state.conn()?;
    let rows = session_builder::load_all(&c)?;
    let eff = session_builder::effective_map(&rows);
    let last_attempts = last_attempt_map(&c)?;
    // Title/objectives come from ONE batched read (R14c) — previously this
    // ran a per-concept query for each of the ~200 curriculum rows.
    let mut metas = load_all_concept_meta(&c)?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let st: ConceptState = session_builder::classify_state(row, &eff);
        let meta = metas
            .remove(&row.id)
            .ok_or_else(|| format!("could not read concept {}", row.id))?;
        out.push(Concept {
            id: row.id.clone(),
            domain: row.domain.clone(),
            module: meta.module,
            title: meta.title,
            prerequisites: row.prerequisites.clone(),
            learning_objectives: meta.objectives,
            difficulty_tier: row.difficulty_tier,
            error_patterns: meta.patterns,
            mastery_score: row.mastery_score,
            // The row's own accessor, so the H16 placement-seed decay
            // exemption applies here exactly as it does in gating.
            effective_mastery: row.effective_mastery(),
            ease_factor: row.ease_factor,
            interval_days: row.interval_days,
            next_review: row.next_review.clone(),
            last_attempt_at: last_attempts.get(&row.id).cloned(),
            state: st,
        });
    }
    Ok(out)
}

/// Most recent quiz attempt per concept (max `quiz_answers.created_at`), read
/// in ONE grouped query. Feeds `Concept.last_attempt_at` for dashboard recency.
fn last_attempt_map(conn: &rusqlite::Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT concept_id, MAX(created_at) FROM quiz_answers GROUP BY concept_id")
        .map_err(|e| crate::util::internal_error("read attempt recency", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| crate::util::internal_error("read attempt recency", e))?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, at) = r.map_err(|e| crate::util::internal_error("read attempt recency", e))?;
        if let Some(at) = at {
            out.insert(id, at);
        }
    }
    Ok(out)
}

/// Per-concept display metadata (title/module/objectives/patterns).
struct ConceptMeta {
    title: String,
    module: String,
    objectives: Vec<String>,
    patterns: Vec<String>,
}

/// Every concept's display metadata in ONE query (R14c), keyed by id.
fn load_all_concept_meta(
    conn: &rusqlite::Connection,
) -> Result<HashMap<String, ConceptMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title, module, learning_objectives, error_patterns FROM concepts")
        .map_err(|e| crate::util::internal_error("read the concepts", e))?;
    let rows = stmt
        .query_map([], |r| {
            let obj_json: String = r.get(3)?;
            let pat_json: String = r.get(4)?;
            Ok((
                r.get::<_, String>(0)?,
                ConceptMeta {
                    title: r.get(1)?,
                    module: r.get(2)?,
                    objectives: serde_json::from_str(&obj_json).unwrap_or_default(),
                    patterns: serde_json::from_str(&pat_json).unwrap_or_default(),
                },
            ))
        })
        .map_err(|e| crate::util::internal_error("read the concepts", e))?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, meta) = r.map_err(|e| crate::util::internal_error("read the concepts", e))?;
        out.insert(id, meta);
    }
    Ok(out)
}

// ---- Study-minute tracking (daily-goal ring; #25) ----

/// Add tracked study minutes for today. The daily-goal ring reads this REAL
/// value (never a hardcoded percentage — blocklist H1).
#[tauri::command]
pub fn add_study_minutes(state: State<'_, AppState>, minutes: i64) -> Result<(), String> {
    validate::in_range_i64("minutes", minutes, 0, 600)?;
    let c = state.conn()?;
    add_study_minutes_into_conn(&c, minutes)
}

/// Body of `add_study_minutes` against a plain connection (testable).
pub(crate) fn add_study_minutes_into_conn(
    conn: &rusqlite::Connection,
    minutes: i64,
) -> Result<(), String> {
    if minutes <= 0 {
        return Ok(());
    }
    gamification::add_session_minutes(conn, &today_local(), minutes)?;
    // R13: tracked study time is real activity — the first flush after a day
    // boundary advances the streak (`touch_streak` is idempotent within a
    // day, so the per-minute flush cadence never double-counts).
    gamification::touch_streak(conn, &today_local())?;
    Ok(())
}

#[tauri::command]
pub fn get_daily_progress(state: State<'_, AppState>) -> Result<DailyProgress, String> {
    let c = state.conn()?;
    let minutes_today = gamification::minutes_for_date(&c, &today_local())?;
    let goal_minutes = settings::daily_goal_minutes(&c)?;
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

    fn ga(question_id: &str, user_answer: &str, is_correct: bool) -> GradedAnswer {
        GradedAnswer {
            question_id: question_id.into(),
            user_answer: user_answer.into(),
            is_correct,
            score: if is_correct { 1.0 } else { 0.0 },
            error_pattern_detected: None,
            correct_answer: Some("x".into()),
            feedback: None,
        }
    }

    fn seed_concept(conn: &rusqlite::Connection, id: &str) {
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title, difficulty_tier) \
             VALUES(?1, 'algebra', 'm1', 'T', 2)",
            [id],
        )
        .unwrap();
    }

    /// Three questions: the canonical minimum a valid quiz may have (H21).
    fn canonical_questions() -> Vec<Question> {
        (1..=3)
            .map(|n| Question {
                id: format!("q{n}"),
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
            })
            .collect()
    }

    /// Cache the canonical questions for a concept; returns the row id (the
    /// quiz nonce the persist path deletes by).
    fn seed_quiz_cache(conn: &rusqlite::Connection, id: &str) -> i64 {
        let payload = serde_json::to_string(&canonical_questions()).unwrap();
        crate::cache::put(conn, id, "quiz", &payload, None, None).unwrap()
    }

    /// Recording a graded quiz persists the answers, bumps attempt_count,
    /// advances the schedule, and awards quiz XP EXACTLY ONCE ACROSS REPEAT
    /// RECORDINGS. Drives the REAL `record_into_conn` through two committed
    /// transactions — this pins the `already_awarded` guard and its
    /// `quiz:<id>` source key (the ledger's only bound now that there is no
    /// pruning job); deleting the guard or drifting the key fails here.
    #[test]
    fn record_persists_and_awards_once() {
        let mut conn = db();
        seed_concept(&conn, "alg_001");
        let questions = canonical_questions();

        let answers = vec![ga("q1", "a", true), ga("q2", "a", true), ga("q3", "a", true)];

        // First recording: rows written, attempt 1, XP granted.
        let tx = conn.transaction().unwrap();
        let snap1 =
            record_into_conn(&tx, "alg_001", &questions, &answers, &[None, None, None]).unwrap();
        tx.commit().unwrap();
        assert_eq!(snap1.xp, gamification::QUIZ_XP);
        assert_eq!(snap1.streak.current_streak, 1, "activity touches the streak");

        // Second full recording (a retake): rows + attempt_count advance, but
        // quiz XP is NOT granted again.
        let tx = conn.transaction().unwrap();
        let snap2 =
            record_into_conn(&tx, "alg_001", &questions, &answers, &[None, None, None]).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            snap2.xp,
            gamification::QUIZ_XP,
            "quiz XP must be granted exactly once across retakes"
        );

        let answer_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(answer_rows, 6, "both attempts' answers persist");
        let attempt_count: i64 = conn
            .query_row(
                "SELECT attempt_count FROM concepts WHERE id = 'alg_001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempt_count, 2);
        // Mastery recomputed over the rolling window that now includes the
        // persisted answers.
        let attempts = recent_attempts(&conn, "alg_001").unwrap();
        assert!(mastery_calc::composite_mastery(&attempts) > 0.0);
    }

    /// The pending stash SNAPSHOTS the canonical questions: `retry_persist`
    /// succeeds with ZERO cache rows in existence — a later persist consuming
    /// other rows (or the revealed-quiz cleanup, or the TTL purge) can never
    /// strand a graded-but-unpersisted result. (The old code re-read the
    /// cache on retry, so any successful persist for the concept made the
    /// pending first attempt permanently unsaveable.)
    #[test]
    fn retry_persist_survives_cache_rows_vanishing() {
        let conn = db();
        seed_concept(&conn, "alg_001");
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: std::env::temp_dir(),
        };
        let pending = PendingPersists::default();
        let token = pending
            .stash(PendingQuiz {
                concept_id: "alg_001".into(),
                questions: canonical_questions(),
                graded: vec![ga("q1", "a", true), ga("q2", "a", true), ga("q3", "a", true)],
                latencies_ms: vec![Some(900), None, Some(1500)],
                final_score: 1.0,
                all_correct: true,
            })
            .unwrap();

        // No content_cache row exists at all — the retry must not need one.
        let outcome = retry_persist_inner(&state, &pending, token).unwrap();
        assert!(outcome.recorded, "retry persists from the snapshot alone");
        assert!(outcome.retry_token.is_none());
        let rows: i64 = state
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 3, "all graded answers persisted");
        // The snapshot's canonical metadata (not a cache re-read) fed the rows.
        let qtype: String = state
            .conn()
            .unwrap()
            .query_row(
                "SELECT question_type FROM quiz_answers WHERE question_id = 'q1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(qtype, "multiple_choice");
    }

    /// R13: lesson XP awards and study-minute flushes both count as real
    /// activity and touch the streak — exactly once per day no matter how
    /// many sources fire, and XP stays one-shot.
    #[test]
    fn lesson_xp_and_study_minutes_touch_streak_once_per_day() {
        let conn = db();
        seed_concept(&conn, "alg_001");

        let snap = award_lesson_xp_into_conn(&conn, "alg_001").unwrap();
        assert_eq!(snap.xp, gamification::LESSON_XP);
        assert_eq!(snap.streak.current_streak, 1, "lesson completion starts the streak");

        // Re-completing the lesson: no double XP, and same-day streak holds.
        let snap = award_lesson_xp_into_conn(&conn, "alg_001").unwrap();
        assert_eq!(snap.xp, gamification::LESSON_XP, "lesson XP stays one-shot");
        assert_eq!(snap.streak.current_streak, 1, "same-day activity counts once");

        // A study-minute flush the same day also holds at 1 (idempotent)…
        add_study_minutes_into_conn(&conn, 5).unwrap();
        let snap = gamification::snapshot(&conn).unwrap();
        assert_eq!(snap.streak.current_streak, 1);
        assert_eq!(
            gamification::minutes_for_date(&conn, &today_local()).unwrap(),
            5
        );

        // …and a zero-minute flush is NOT activity (no touch, no row).
        conn.execute("DELETE FROM settings WHERE key = '__streak_state'", [])
            .unwrap();
        add_study_minutes_into_conn(&conn, 0).unwrap();
        let snap = gamification::snapshot(&conn).unwrap();
        assert_eq!(snap.streak.current_streak, 0, "0 minutes must not touch the streak");

        // Day-boundary mechanics (the timer's first flush of a NEW day
        // advances the streak) are pinned at the gamification layer, where
        // the date is injectable: touch on consecutive dates increments.
        let s1 = gamification::touch_streak(&conn, "2026-07-01").unwrap();
        let s2 = gamification::touch_streak(&conn, "2026-07-02").unwrap();
        assert_eq!(s1.current_streak + 1, s2.current_streak);
    }

    /// Atomicity (the merged command's persist step): if any step fails after
    /// some answers were inserted, the whole sequence rolls back — no partial
    /// state, so a retry cannot double-insert. Here the 2nd answer references
    /// an unknown question, failing mid-loop after the 1st insert; on the
    /// aborted transaction `quiz_answers` must stay empty.
    #[test]
    fn record_rolls_back_on_mid_sequence_failure() {
        let mut conn = db();
        seed_concept(&conn, "alg_001");
        let questions = canonical_questions();

        let answers = vec![ga("q1", "a", true), ga("does_not_exist", "z", false)];

        let tx = conn.transaction().unwrap();
        let result = record_into_conn(&tx, "alg_001", &questions, &answers, &[None, None]);
        assert!(result.is_err(), "unknown question must fail the call");
        drop(tx); // no commit → rollback

        let answer_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            answer_rows, 0,
            "first insert must roll back with the failure"
        );
        let attempt_count: i64 = conn
            .query_row(
                "SELECT attempt_count FROM concepts WHERE id = 'alg_001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            attempt_count, 0,
            "schedule must not advance on a failed record"
        );
        assert_eq!(
            gamification::total_xp(&conn).unwrap(),
            0,
            "no XP on failure"
        );
    }

    /// A clean record commits every write together: the answer is persisted,
    /// attempt_count advances once, and quiz XP is granted exactly once.
    #[test]
    fn record_commits_all_writes_together() {
        let mut conn = db();
        seed_concept(&conn, "alg_001");
        let questions = canonical_questions();

        let answers = vec![ga("q1", "a", true)];

        let tx = conn.transaction().unwrap();
        record_into_conn(&tx, "alg_001", &questions, &answers, &[None]).unwrap();
        tx.commit().unwrap();

        let answer_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(answer_rows, 1);
        let attempt_count: i64 = conn
            .query_row(
                "SELECT attempt_count FROM concepts WHERE id = 'alg_001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempt_count, 1);
        assert_eq!(
            gamification::total_xp(&conn).unwrap(),
            gamification::QUIZ_XP
        );
    }

    /// H9 defense in depth: a duplicated question id aborts the persist inside
    /// the transaction (no partial rows), even though the merged command has
    /// already validated the permutation upstream.
    #[test]
    fn record_rejects_duplicate_question_ids() {
        let mut conn = db();
        seed_concept(&conn, "alg_001");
        let questions = canonical_questions();

        let answers = vec![ga("q1", "a", true), ga("q1", "a", true)];

        let tx = conn.transaction().unwrap();
        let result = record_into_conn(&tx, "alg_001", &questions, &answers, &[None, None]);
        let err = result.unwrap_err();
        assert!(err.contains("more than once"), "dup error: {err}");
        drop(tx); // rollback

        let answer_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(answer_rows, 0, "duplicate submission persists nothing");
    }

    /// The persist-retry state is one-shot per token: stash → take succeeds
    /// once; a second take (double-click on Retry) finds nothing. put_back
    /// restores the SAME token for the next retry after a failed persist.
    #[test]
    fn pending_persists_are_one_shot_and_restorable() {
        let pending = PendingPersists::default();
        let entry = PendingQuiz {
            concept_id: "alg_001".into(),
            questions: canonical_questions(),
            graded: vec![ga("q1", "a", true)],
            latencies_ms: vec![Some(1200)],
            final_score: 1.0,
            all_correct: true,
        };

        let token = pending.stash(entry.clone()).unwrap();
        assert_eq!(token.len(), 32, "opaque 16-byte hex token");

        let taken = pending.take(&token).unwrap().expect("first take succeeds");
        assert_eq!(taken.concept_id, "alg_001");
        assert!(
            pending.take(&token).unwrap().is_none(),
            "second take must find nothing (one-shot)"
        );

        // Failed retry path: put_back under the same token, retry again works.
        pending.put_back(&token, taken).unwrap();
        assert!(pending.take(&token).unwrap().is_some());

        // Tokens are unique across stashes.
        let t2 = pending.stash(entry).unwrap();
        assert_ne!(token, t2);
    }

    /// End-to-end persist through `persist_graded` against a real AppState:
    /// success returns the refreshed gamification snapshot and consumes ONLY
    /// the graded quiz's own cache row (a sibling row — a quiz another window
    /// may be answering — survives); a failing persist (unknown concept)
    /// leaves NO partial writes.
    #[test]
    fn persist_graded_commits_or_leaves_no_trace() {
        let conn = db();
        seed_concept(&conn, "alg_001");
        let graded_row = seed_quiz_cache(&conn, "alg_001");
        let sibling_row = seed_quiz_cache(&conn, "alg_001");
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: std::env::temp_dir(),
        };
        let questions = canonical_questions();

        let graded = vec![ga("q1", "a", true), ga("q2", "a", true), ga("q3", "a", true)];
        let snapshot = persist_graded(
            &state,
            "alg_001",
            &questions,
            &graded,
            &[Some(900), None, Some(1500)],
            Some(graded_row),
        )
        .unwrap();
        assert_eq!(snapshot.xp, gamification::QUIZ_XP);

        // R5, per-instance: the graded quiz's OWN row is consumed (its answer
        // key was just revealed, so grading it again must be impossible)…
        {
            let c = state.conn().unwrap();
            assert!(
                crate::cache::get_by_id(&c, "alg_001", "quiz", graded_row)
                    .unwrap()
                    .is_none(),
                "graded row consumed"
            );
            // …but ONLY that row: a concurrently generated quiz another
            // window is actively answering must stay gradable.
            assert!(
                crate::cache::get_by_id(&c, "alg_001", "quiz", sibling_row)
                    .unwrap()
                    .is_some(),
                "sibling quiz row must survive"
            );
        }

        // An unknown concept → error, and no new rows beyond the successful
        // persist above (the transaction rolled back).
        let err = persist_graded(&state, "alg_002", &questions, &graded, &[None, None, None], None)
            .unwrap_err();
        assert!(!err.is_empty());
        let rows: i64 = state
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM quiz_answers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 3, "failed persist must not add rows");
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
