//! Placement micro-quiz command surface (milestone 4).
//!
//! A 5-question micro-quiz (NOT a full diagnostic) sampled across early-phase
//! domains (algebra, light precalc, light trig) at tiers 1–3. Generation reuses
//! the SAME quiz prompt + locked schema as `generate_quiz`; grading is
//! SERVER-AUTHORITATIVE (the frontend sends only `{questionId, answer}`, never a
//! correctness flag — blocklist #0a). The canonical question JSON is held
//! server-side under a reserved settings key between generate and grade.
//!
//! Placement (per the milestone spec): count correct out of 5, then place at
//! `< 2` foundational algebra, `2..=3` intermediate algebra, `>= 4` precalculus.
//!
//! The chosen target's prerequisites are seeded so it is actually unlocked, and
//! a modest starting mastery/ease is seeded where the demonstrated level
//! justifies it. The adaptive engine corrects any mis-placement within a few
//! quizzes, so 5 questions is deliberately enough.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ai::prompt::{build_user_message, ConceptContext, LearnerContext, Mode};
use crate::ai::{client, AiState};
use crate::contract::{AnswerSubmission, PlacementResult, Question, WireQuestion};
use crate::db::AppState;
use crate::{grading, keychain, settings, validate};

/// The five concepts sampled for placement: three algebra (tiers 1→3) plus one
/// light precalc and one light trig. Ordered so question ids q1..q5 are stable.
const PLACEMENT_CONCEPTS: &[&str] = &["alg_001", "alg_013", "alg_024", "prec_001", "trig_007"];

/// Placement targets (the concept the learner starts at) keyed by demonstrated
/// level. Each is a real curriculum concept id.
const FOUNDATIONAL_ALGEBRA: &str = "alg_001";
const INTERMEDIATE_ALGEBRA: &str = "alg_017";
const PRECALCULUS_START: &str = "prec_001";

fn require_key() -> Result<String, String> {
    match keychain::get_key()? {
        Some(k) if !k.trim().is_empty() => Ok(k),
        _ => Err("no API key configured".to_string()),
    }
}

/// One placement question plus the domain it was sampled from (so placement can
/// weight algebra performance). Serialized into the reserved canonical store.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlacementItem {
    domain: String,
    question: Question,
}

/// Decide the placement target from the correct-count. Pure so it is unit-test
/// friendly (the required placement test drives this directly).
pub fn decide_target(correct: usize) -> &'static str {
    if correct < 2 {
        FOUNDATIONAL_ALGEBRA
    } else if correct < 4 {
        INTERMEDIATE_ALGEBRA
    } else {
        PRECALCULUS_START
    }
}

/// A modest seed mastery for the chosen target, scaled by demonstrated level.
/// Never high enough to skip the concept — just enough that the adaptive engine
/// starts the learner warm rather than cold.
fn seed_mastery(correct: usize) -> f64 {
    match correct {
        0 | 1 => 0.0,
        2 | 3 => 0.3,
        _ => 0.5,
    }
}

/// Load one concept's curriculum context for prompt assembly. Mirrors
/// `commands_ai::load_concept` but only the fields the quiz prompt needs.
fn concept_context(conn: &rusqlite::Connection, id: &str) -> Result<ConceptContext, String> {
    conn.query_row(
        "SELECT title, domain, module, difficulty_tier, learning_objectives, error_patterns \
         FROM concepts WHERE id = ?1 LIMIT 1",
        [id],
        |r| {
            let obj_json: String = r.get(4)?;
            let pat_json: String = r.get(5)?;
            Ok(ConceptContext {
                id: id.to_string(),
                title: r.get(0)?,
                domain: r.get(1)?,
                module: r.get(2)?,
                difficulty_tier: r.get::<_, Option<i64>>(3)?.unwrap_or(1),
                learning_objectives: serde_json::from_str(&obj_json).unwrap_or_default(),
                error_patterns: serde_json::from_str(&pat_json).unwrap_or_default(),
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("unknown placement concept {id}"),
        other => {
            tracing::error!(error = %other, "load placement concept failed");
            "could not read a placement concept".to_string()
        }
    })
}

/// Generate the 5-question placement micro-quiz. Each source concept yields one
/// question (the first of its generated quiz), re-id'd q1..q5 so the frontend
/// and grader agree. The canonical JSON is stored server-side and grading reads
/// ONLY that copy; the webview receives the REDACTED `WireQuestion` shape — no
/// option `isCorrect`, no blanks, no rubric (H10).
#[tauri::command]
pub async fn generate_placement_quiz(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
) -> Result<Vec<WireQuestion>, String> {
    let key = require_key()?;

    // Gather each concept's prompt context up front (single short locked section).
    let contexts: Vec<ConceptContext> = {
        let c = state.conn()?;
        let mut v = Vec::with_capacity(PLACEMENT_CONCEPTS.len());
        for id in PLACEMENT_CONCEPTS {
            v.push(concept_context(&c, id)?);
        }
        v
    };
    let model = {
        let c = state.conn()?;
        settings::base_model(&c)?
    };

    // A neutral learner context (placement is the first thing a new user sees).
    let learner = LearnerContext {
        mastery_score: 0.0,
        attempt_count: 0,
        streak_correct: 0,
        ease_factor: 2.5,
        last_latency_ms: None,
    };

    // R9: the five per-concept generations run CONCURRENTLY (the same
    // join_all pattern the grade path uses) — first-run latency is one model
    // round-trip instead of five sequential ones. Slots keep concept order so
    // q1..q5 stay stable.
    let ai_ref: &AiState = &ai;
    let key_ref: &str = &key;
    let model_ref: &str = &model;
    let futures: Vec<_> = contexts
        .iter()
        .enumerate()
        .map(|(i, ctx)| {
            let msg = build_user_message(Mode::Quiz, None, ctx, &learner, None);
            async move {
                let raw = client::complete(ai_ref, key_ref, model_ref, &msg).await?;
                // Lenient parse for FRESH model output (ids are re-assigned
                // below anyway; a duplicate-id slip must not fail placement).
                let questions = crate::ai::quiz_schema::parse_and_renumber(&raw)?;
                let mut q = questions
                    .into_iter()
                    .next()
                    .ok_or("placement question generation returned no questions")?;
                // Stable, predictable ids the grader matches against.
                q.id = format!("q{}", i + 1);
                Ok::<(usize, PlacementItem), String>((
                    i,
                    PlacementItem {
                        domain: ctx.domain.clone(),
                        question: q,
                    },
                ))
            }
        })
        .collect();

    let mut slots: Vec<Option<PlacementItem>> = contexts.iter().map(|_| None).collect();
    for result in futures_util::future::join_all(futures).await {
        let (i, item) = result?;
        slots[i] = Some(item);
    }
    let items: Vec<PlacementItem> = slots
        .into_iter()
        .map(|s| s.ok_or("internal: a placement question was left unfilled"))
        .collect::<Result<_, _>>()?;

    // Persist the canonical placement quiz (with per-item domain) server-side.
    let payload = serde_json::to_string(&items)
        .map_err(|e| crate::util::internal_error("store the placement quiz", e))?;
    {
        let c = state.conn()?;
        settings::set_placement_quiz(&c, &payload)?;
    }

    Ok(items.iter().map(|it| WireQuestion::from(&it.question)).collect())
}

/// Whether first-run onboarding + placement has been completed (gates routing
/// to `/onboarding` on launch). Reads the reserved internal flag.
#[tauri::command]
pub fn get_onboarding_complete(state: State<'_, AppState>) -> Result<bool, String> {
    let c = state.conn()?;
    settings::get_onboarding_complete(&c)
}

/// Skip placement entirely: the learner chose "let me pick where to start".
/// We seed the foundational starting point (so the base concepts are unlocked
/// and there is somewhere to begin) and mark onboarding complete, WITHOUT any
/// mastery seeding beyond the unlocked base. The learner then picks an unlocked
/// concept from the curriculum diagram / browse list.
#[tauri::command]
pub fn skip_placement(state: State<'_, AppState>) -> Result<(), String> {
    let c = state.conn()?;
    // Seed + flag + quiz-discard commit together or not at all.
    let tx = c
        .unchecked_transaction()
        .map_err(|e| crate::util::internal_error("start the placement update", e))?;
    // Mastery 0.0: a pure cold start, just the gate opened on the base concept.
    seed_placement(&tx, FOUNDATIONAL_ALGEBRA, 0.0)?;
    settings::set_onboarding_complete(&tx, true)?;
    // Discard any half-generated placement quiz so a later real run regenerates.
    settings::clear_placement_quiz(&tx)?;
    tx.commit()
        .map_err(|e| crate::util::internal_error("save the placement update", e))?;
    Ok(())
}

/// Grade the placement answers server-side, decide a starting concept, seed its
/// schedule + prerequisites so it is unlocked, and mark onboarding complete.
/// Objective questions are graded deterministically; any free_response is graded
/// by the model against its rubric (same path as `grade_and_record_quiz`).
///
/// H9: the submission must be an EXACT PERMUTATION of the canonical placement
/// question ids — duplicating one correct answer 5 times must never reach the
/// top placement, and `PlacementResult.total` is the CANONICAL count.
#[tauri::command]
pub async fn place_learner(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
    answers: Vec<AnswerSubmission>,
) -> Result<PlacementResult, String> {
    place_learner_inner(&state, &ai, answers).await
}

/// The testable body of `place_learner` (the command wrapper only unwraps
/// Tauri state) — the permutation gate and the R4 input bounds are pinned at
/// THIS edge by tests, so deleting a validate call fails a test.
pub(crate) async fn place_learner_inner(
    state: &AppState,
    ai: &AiState,
    answers: Vec<AnswerSubmission>,
) -> Result<PlacementResult, String> {
    // R4 command-edge bounds: friendly rejects BEFORE any DB write or model
    // call. (latency_ms is currently unused by placement, but the bound keeps
    // the two AnswerSubmission edges symmetrical.)
    for a in &answers {
        validate::answer_text(&a.answer)?;
        validate::latency_ms(a.latency_ms)?;
    }

    // Canonical questions from the server's own stored copy (NOT the frontend).
    let items: Vec<PlacementItem> = {
        let c = state.conn()?;
        let raw = settings::get_placement_quiz(&c)?
            .ok_or("no placement quiz on record — generate one first")?;
        serde_json::from_str(&raw)
            .map_err(|e| crate::util::internal_error("read the placement quiz", e))?
    };

    // Exactly one answer per canonical placement question (dedupe + coverage).
    let canonical_ids: Vec<&str> = items.iter().map(|it| it.question.id.as_str()).collect();
    validate::answer_permutation(&canonical_ids, answers.iter().map(|a| &a.question_id))?;

    // Does the placement quiz contain a free_response needing a model grade?
    let needs_model = items.iter().any(|it| {
        matches!(
            it.question.question_type,
            crate::contract::QuestionType::FreeResponse
        )
    });
    let key_and_model = if needs_model {
        let model = {
            let c = state.conn()?;
            settings::base_model(&c)?
        };
        Some((require_key()?, model))
    } else {
        None
    };

    let mut correct = 0usize;
    for a in &answers {
        let Some(it) = items.iter().find(|it| it.question.id == a.question_id) else {
            return Err(format!(
                "answer references unknown placement question {:?}",
                a.question_id
            ));
        };
        let graded = match grading::grade_objective(&it.question, &a.answer) {
            Some(g) => g,
            None => {
                let (k, m) = key_and_model
                    .as_ref()
                    .ok_or("internal: free_response needs a model")?;
                let rubric = it
                    .question
                    .rubric
                    .as_deref()
                    .unwrap_or("Grade for correctness.");
                let prompt = build_grading_prompt(&it.question.prompt, rubric, &a.answer);
                let raw = client::complete(ai, k, m, &prompt).await?;
                let (score, fb, ep) = client::parse_free_response_grade(&raw)?;
                grading::grade_free_response_from_score(&it.question, &a.answer, score, fb, ep)
            }
        };
        if graded.is_correct {
            correct += 1;
        }
    }

    let target = decide_target(correct);
    let mastery = seed_mastery(correct);

    let (domain, title) = {
        let c = state.conn()?;
        // Grade result is already in hand; every WRITE this decision produces
        // (prereq seeding, onboarding flag, quiz consumption) commits together
        // or rolls back together — no half-placed learner on a mid-write error.
        let tx = c
            .unchecked_transaction()
            .map_err(|e| crate::util::internal_error("start the placement update", e))?;
        seed_placement(&tx, target, mastery)?;
        settings::set_onboarding_complete(&tx, true)?;
        // Clear the one-shot canonical placement quiz now that it is consumed.
        settings::clear_placement_quiz(&tx)?;
        let row = tx
            .query_row(
                "SELECT domain, title FROM concepts WHERE id = ?1 LIMIT 1",
                [target],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|e| crate::util::internal_error("read the placement target", e))?;
        tx.commit()
            .map_err(|e| crate::util::internal_error("save the placement update", e))?;
        row
    };

    Ok(PlacementResult {
        concept_id: target.to_string(),
        domain,
        title,
        correct_count: correct as i64,
        // The CANONICAL question count — never the submitted-answer count
        // (which the permutation gate has made equal, but the canonical count
        // is the honest source).
        total: items.len() as i64,
    })
}

/// How far out a seeded prerequisite's next_review is pushed. Defense in depth:
/// a NULL next_review reads as "due now" for attempted rows, so seeds must
/// never sit at NULL even though seeded rows also stay out of the review queue
/// via attempt_count = 0 (H16).
const SEED_REVIEW_DAYS: i64 = 60;

/// Seed the chosen target so it is reachable: set its starting mastery, and
/// mark every (transitive) prerequisite as placement-complete so the gate
/// opens. Seeding is a PLACEMENT DECISION, not a learner attempt (H16):
/// - prerequisites keep attempt_count = 0 (no fabricated attempt) and are
///   recorded in the reserved `__placement_seeded` set — the session builder
///   keeps them out of the new/review queues and exempts them from decay until
///   the learner genuinely attempts them;
/// - their next_review is pushed `SEED_REVIEW_DAYS` out (never left NULL);
/// - existing real history (last_correct / next_review of already-attempted
///   rows) is never clobbered — only the mastery floor is raised;
/// - the target's mastery is set without touching attempt_count so it still
///   presents as fresh work.
fn seed_placement(conn: &rusqlite::Connection, target: &str, mastery: f64) -> Result<(), String> {
    // Unlock prerequisites transitively (the gate reads effective mastery on
    // EVERY prerequisite, including cross-domain). Seed them as completed.
    let prereqs = transitive_prerequisites(conn, target)?;
    let seed_review = (chrono::Local::now().date_naive()
        + chrono::Duration::days(SEED_REVIEW_DAYS))
    .format("%Y-%m-%d")
    .to_string();
    for p in &prereqs {
        conn.execute(
            "UPDATE concepts SET mastery_score = MAX(mastery_score, 0.85), \
                last_correct = COALESCE(last_correct, ?2), \
                next_review = COALESCE(next_review, ?3) \
             WHERE id = ?1",
            rusqlite::params![p, today_local(), seed_review],
        )
        .map_err(|e| crate::util::internal_error("seed a placement prerequisite", e))?;
    }
    settings::add_placement_seeded(conn, &prereqs)?;

    // Seed the target's starting mastery (attempt_count stays 0 → still "new").
    conn.execute(
        "UPDATE concepts SET mastery_score = ?2 WHERE id = ?1",
        rusqlite::params![target, mastery],
    )
    .map_err(|e| crate::util::internal_error("seed the placement target", e))?;
    Ok(())
}

/// Collect all transitive prerequisites of a concept (BFS over the prereq JSON).
fn transitive_prerequisites(conn: &rusqlite::Connection, id: &str) -> Result<Vec<String>, String> {
    use std::collections::{HashSet, VecDeque};
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(id.to_string());
    let mut out = Vec::new();
    while let Some(cur) = queue.pop_front() {
        let prereq_json: Option<String> = conn
            .query_row(
                "SELECT prerequisites FROM concepts WHERE id = ?1 LIMIT 1",
                [&cur],
                |r| r.get(0),
            )
            .ok();
        let prereqs: Vec<String> = prereq_json
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        for p in prereqs {
            if seen.insert(p.clone()) {
                out.push(p.clone());
                queue.push_back(p);
            }
        }
    }
    Ok(out)
}

fn today_local() -> String {
    chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

/// Free_response grading turn (identical shape to `commands_ai`'s helper). The
/// learner answer + rubric are escaped (untrusted input; #41).
fn build_grading_prompt(prompt: &str, rubric: &str, answer: &str) -> String {
    use crate::util::xml_escape;
    format!(
        "<mode>grade_free_response</mode>\n\
         <question>{}</question>\n\
         <rubric>{}</rubric>\n\
         <student_answer>{}</student_answer>\n\
         Respond with ONLY a JSON object: \
         {{\"score\": <0.0-1.0>, \"feedback\": \"...\", \"error_pattern\": \"...\"|null}}.",
        xml_escape(prompt),
        xml_escape(rubric),
        xml_escape(answer),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Required test: a learner who answers (algebra) questions correctly is
    /// placed PAST intro algebra; one who misses them is not.
    #[test]
    fn placement_thresholds_match_spec() {
        // Missed everything → foundational (intro) algebra.
        assert_eq!(decide_target(0), FOUNDATIONAL_ALGEBRA);
        assert_eq!(decide_target(1), FOUNDATIONAL_ALGEBRA);
        // Got the early (algebra) questions → past intro: intermediate algebra.
        assert_eq!(decide_target(2), INTERMEDIATE_ALGEBRA);
        assert_eq!(decide_target(3), INTERMEDIATE_ALGEBRA);
        // Strong across the board → precalculus.
        assert_eq!(decide_target(4), PRECALCULUS_START);
        assert_eq!(decide_target(5), PRECALCULUS_START);

        // The "past intro" target is genuinely different from the intro one.
        assert_ne!(decide_target(3), decide_target(0));
    }

    #[test]
    fn seed_mastery_scales_but_never_skips() {
        assert_eq!(seed_mastery(0), 0.0);
        assert!(seed_mastery(3) > 0.0 && seed_mastery(3) < 0.8);
        assert!(seed_mastery(5) < 0.8, "seed must not skip the concept");
    }

    /// H9: the exact-permutation gate `place_learner` runs over the canonical
    /// q1..q5 ids. Submitting one correct answer five times, or only a subset,
    /// is rejected before any grading — so `correct` can never exceed the
    /// number of distinct canonical questions actually answered right.
    #[test]
    fn placement_answers_must_be_exact_permutation_of_q1_to_q5() {
        let canonical = ["q1", "q2", "q3", "q4", "q5"];

        // Honest full submission (any order) passes.
        assert!(validate::answer_permutation(
            &canonical,
            ["q5", "q4", "q3", "q2", "q1"]
        )
        .is_ok());

        // Five duplicates of one correct answer: rejected (was: top placement).
        let err = validate::answer_permutation(&canonical, ["q1"; 5].to_vec()).unwrap_err();
        assert!(err.contains("more than once"), "dup error: {err}");

        // A cherry-picked subset: rejected.
        let err = validate::answer_permutation(&canonical, ["q1", "q2"]).unwrap_err();
        assert!(err.contains("answer every question"), "subset error: {err}");

        // An id outside the canonical five: rejected.
        let err =
            validate::answer_permutation(&canonical, ["q1", "q2", "q3", "q4", "q9"]).unwrap_err();
        assert!(err.contains("unknown question"), "unknown error: {err}");
    }

    /// H16 end-to-end through SQLite: seeding a placement target unlocks it
    /// WITHOUT fabricating attempts, without flooding the review queue, and
    /// with a future next_review on every seeded prerequisite. The target is
    /// the session's new work; the seeded chain never is.
    #[test]
    fn seed_placement_unlocks_target_without_flooding_reviews() {
        use crate::adaptive::session as session_builder;

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        for (id, prereqs) in [
            ("alg_001", "[]"),
            ("alg_002", r#"["alg_001"]"#),
            ("prec_001", r#"["alg_002"]"#),
        ] {
            conn.execute(
                "INSERT INTO concepts(id, domain, module, title, prerequisites) \
                 VALUES(?1, 'algebra', 'm1', 'T', ?2)",
                [id, prereqs],
            )
            .unwrap();
        }

        seed_placement(&conn, "prec_001", 0.3).unwrap();

        // Prereqs: mastery floor raised, NO fabricated attempt, review pushed
        // out, and recorded in the seeded set.
        let (attempts, next_review): (i64, Option<String>) = conn
            .query_row(
                "SELECT attempt_count, next_review FROM concepts WHERE id = 'alg_001'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(attempts, 0, "seeding must not fabricate an attempt");
        assert!(
            next_review.expect("seeded next_review set") > today_local(),
            "seeded next_review must be in the future, never NULL/due"
        );
        let seeded = settings::get_placement_seeded(&conn).unwrap();
        assert!(seeded.contains("alg_001") && seeded.contains("alg_002"));
        assert!(!seeded.contains("prec_001"), "the target is NOT a seed");

        // Session: the target is the new work; the seeded chain is neither new
        // work nor a review flood.
        let session = session_builder::build_session(&conn, 3, 30).unwrap();
        assert_eq!(session.concepts_new, vec!["prec_001".to_string()]);
        assert!(
            session.concepts_review.is_empty(),
            "seeded prereqs must not flood the review queue"
        );

        // And the seeded chain presents as Completed in the concept map.
        let rows = session_builder::load_all(&conn).unwrap();
        let eff = session_builder::effective_map(&rows);
        let alg_001 = rows.iter().find(|r| r.id == "alg_001").unwrap();
        assert_eq!(
            session_builder::classify_state(alg_001, &eff),
            crate::contract::ConceptState::Completed
        );
    }

    /// H19 day-one regression on the REAL curriculum: after placement at a
    /// mid-curriculum target, the target — not an early-alphabet sibling —
    /// leads the session queue. lin_005 is adversarial: seeding its chain
    /// (all of svc → prec → trig → alg, plus lin_001..004) also unlocks
    /// mvc_001 and de_001, and bare id order would put de_001 first.
    #[test]
    fn placement_target_leads_day_one_queue_on_real_curriculum() {
        use crate::adaptive::session as session_builder;

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        crate::curriculum::load_into_db(&conn).expect("bundled curriculum loads");

        seed_placement(&conn, "lin_005", 0.3).unwrap();

        // Capstone anchoring (H14) makes the WHOLE prerequisite chain load-
        // bearing: lin_001..004 + all of svc/prec/trig/alg (~156 concepts).
        let seeded = settings::get_placement_seeded(&conn).unwrap();
        assert!(
            (150..=170).contains(&seeded.len()),
            "expected ~156 seeded transitive prerequisites, got {}",
            seeded.len()
        );

        let session = session_builder::build_session(&conn, 3, 30).unwrap();
        assert_eq!(
            session.concepts_new,
            vec![
                "lin_005".to_string(), // the target's domain is the frontier
                "mvc_001".to_string(), // then phase-rank order…
                "de_001".to_string()   // …not id order (de_001 < lin_005 < mvc_001)
            ],
            "the placement target must lead day one"
        );
        assert_eq!(session.interleaved_set.first().map(String::as_str), Some("lin_005"));
        assert!(
            session.concepts_review.is_empty(),
            "seeded prerequisites must not flood the review queue"
        );
    }

    // ---- Command-level wiring tests (R-TESTS i): drive the REAL
    // place_learner body so deleting a validate call fails a test. ----

    fn mc_item(n: usize) -> PlacementItem {
        PlacementItem {
            domain: "algebra".into(),
            question: Question {
                id: format!("q{n}"),
                question_type: crate::contract::QuestionType::MultipleChoice,
                prompt: "p".into(),
                options: Some(vec![
                    crate::contract::QuizOption {
                        id: "a".into(),
                        text: "right".into(),
                        is_correct: true,
                    },
                    crate::contract::QuizOption {
                        id: "b".into(),
                        text: "wrong".into(),
                        is_correct: false,
                    },
                ]),
                blanks: None,
                rubric: None,
                explanation: String::new(),
                difficulty: 1,
                is_transfer: false,
            },
        }
    }

    fn placement_state() -> crate::db::AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title, prerequisites) \
             VALUES('alg_001','algebra','m1','Intro','[]')",
            [],
        )
        .unwrap();
        let items: Vec<PlacementItem> = (1..=5).map(mc_item).collect();
        settings::set_placement_quiz(&conn, &serde_json::to_string(&items).unwrap()).unwrap();
        crate::db::AppState {
            db: std::sync::Mutex::new(conn),
            data_dir: std::env::temp_dir(),
        }
    }

    fn sub(id: &str, answer: &str) -> AnswerSubmission {
        AnswerSubmission {
            question_id: id.into(),
            answer: answer.into(),
            latency_ms: None,
        }
    }

    /// H9 pinned AT THE COMMAND EDGE: a subset submission is rejected by the
    /// permutation gate inside place_learner itself. Without the gate call,
    /// this subset would grade (record_into_conn has no completeness check on
    /// this path) and PLACE the learner — so deleting the call site fails
    /// here, not just in the helper tests.
    #[tokio::test]
    async fn place_learner_rejects_subset_and_duplicates_at_the_edge() {
        let state = placement_state();
        let ai = AiState::new().unwrap();

        let err = place_learner_inner(&state, &ai, vec![sub("q1", "a"), sub("q2", "a")])
            .await
            .unwrap_err();
        assert!(err.contains("answer every question"), "subset: {err}");

        let err = place_learner_inner(
            &state,
            &ai,
            vec![sub("q1", "a"), sub("q1", "a"), sub("q2", "a"), sub("q3", "a"), sub("q4", "a")],
        )
        .await
        .unwrap_err();
        assert!(err.contains("more than once"), "duplicate: {err}");

        // Nothing was placed or consumed by the rejected submissions.
        let c = state.conn().unwrap();
        assert!(!settings::get_onboarding_complete(&c).unwrap());
        assert!(settings::get_placement_quiz(&c).unwrap().is_some());
    }

    /// R4 pinned at the command edge: oversized answers and out-of-range
    /// latencies get FRIENDLY rejects before any grading.
    #[tokio::test]
    async fn place_learner_bounds_answer_and_latency_at_the_edge() {
        let state = placement_state();
        let ai = AiState::new().unwrap();

        let mut answers: Vec<AnswerSubmission> = (1..=5).map(|n| sub(&format!("q{n}"), "a")).collect();
        answers[0].answer = "x".repeat(validate::MAX_ANSWER_LEN + 1);
        let err = place_learner_inner(&state, &ai, answers).await.unwrap_err();
        assert!(err.contains("too long"), "oversize answer: {err}");

        let mut answers: Vec<AnswerSubmission> = (1..=5).map(|n| sub(&format!("q{n}"), "a")).collect();
        answers[2].latency_ms = Some(-40);
        let err = place_learner_inner(&state, &ai, answers).await.unwrap_err();
        assert!(err.contains("timing"), "bad latency: {err}");
    }

    /// Happy path through the REAL command body (all-objective quiz — no
    /// model call): an all-wrong submission places foundational algebra,
    /// consumes the one-shot quiz, and completes onboarding.
    #[tokio::test]
    async fn place_learner_end_to_end_places_and_consumes_quiz() {
        let state = placement_state();
        let ai = AiState::new().unwrap();

        let answers: Vec<AnswerSubmission> = (1..=5).map(|n| sub(&format!("q{n}"), "b")).collect();
        let result = place_learner_inner(&state, &ai, answers).await.unwrap();
        assert_eq!(result.concept_id, FOUNDATIONAL_ALGEBRA);
        assert_eq!(result.correct_count, 0);
        assert_eq!(result.total, 5, "canonical count, never submitted count");

        let c = state.conn().unwrap();
        assert!(settings::get_onboarding_complete(&c).unwrap());
        assert!(
            settings::get_placement_quiz(&c).unwrap().is_none(),
            "one-shot quiz consumed"
        );
    }

    /// H14 perf sanity: capstone anchoring means a deep placement target now
    /// seeds a couple hundred concepts (astr_001 → ~218 transitive prereqs).
    /// Seeding is one pass of upserts (wrapped in a single transaction at the
    /// place_learner call site) and must stay well under a second.
    #[test]
    fn seed_placement_handles_deep_closures_quickly() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        crate::curriculum::load_into_db(&conn).expect("bundled curriculum loads");

        let t0 = std::time::Instant::now();
        seed_placement(&conn, "astr_001", 0.3).unwrap();
        let elapsed = t0.elapsed();

        let seeded = settings::get_placement_seeded(&conn).unwrap();
        eprintln!("[perf] seeded {} prereqs in {elapsed:?}", seeded.len());
        assert!(
            seeded.len() >= 200,
            "deep target must seed whole prerequisite domains, got {}",
            seeded.len()
        );
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "seeding {} prerequisites took {elapsed:?} — must stay <1s",
            seeded.len()
        );
    }
}
