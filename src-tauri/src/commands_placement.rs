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
use crate::commands_ai::SubmittedAnswer;
use crate::contract::Question;
use crate::db::AppState;
use crate::{grading, keychain, settings};

/// The five concepts sampled for placement: three algebra (tiers 1→3) plus one
/// light precalc and one light trig. Ordered so question ids q1..q5 are stable.
const PLACEMENT_CONCEPTS: &[&str] = &["alg_001", "alg_013", "alg_024", "prec_001", "trig_007"];

/// Placement targets (the concept the learner starts at) keyed by demonstrated
/// level. Each is a real curriculum concept id.
const FOUNDATIONAL_ALGEBRA: &str = "alg_001";
const INTERMEDIATE_ALGEBRA: &str = "alg_017";
const PRECALCULUS_START: &str = "prec_001";

fn conn<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state
        .db
        .lock()
        .map_err(|_| "internal db lock error".to_string())
}

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
/// and grader agree. The canonical JSON is stored server-side; the returned
/// questions carry NO correctness signal the frontend could forge.
#[tauri::command]
pub async fn generate_placement_quiz(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
) -> Result<Vec<Question>, String> {
    let key = require_key()?;

    // Gather each concept's prompt context up front (single short locked section).
    let contexts: Vec<ConceptContext> = {
        let c = conn(&state)?;
        let mut v = Vec::with_capacity(PLACEMENT_CONCEPTS.len());
        for id in PLACEMENT_CONCEPTS {
            v.push(concept_context(&c, id)?);
        }
        v
    };
    let model = {
        let c = conn(&state)?;
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

    let mut items: Vec<PlacementItem> = Vec::with_capacity(contexts.len());
    for (i, ctx) in contexts.iter().enumerate() {
        let msg = build_user_message(Mode::Quiz, None, ctx, &learner, None);
        let raw = client::complete(&ai, &key, &model, &msg).await?;
        let questions = crate::ai::quiz_schema::parse_and_repair(&raw)?;
        let mut q = questions
            .into_iter()
            .next()
            .ok_or("placement question generation returned no questions")?;
        // Stable, predictable ids the grader matches against.
        q.id = format!("q{}", i + 1);
        items.push(PlacementItem {
            domain: ctx.domain.clone(),
            question: q,
        });
    }

    // Persist the canonical placement quiz (with per-item domain) server-side.
    let payload = serde_json::to_string(&items).map_err(|e| format!("serialize placement: {e}"))?;
    {
        let c = conn(&state)?;
        settings::set_placement_quiz(&c, &payload)?;
    }

    Ok(items.into_iter().map(|it| it.question).collect())
}

/// Whether first-run onboarding + placement has been completed (gates routing
/// to `/onboarding` on launch). Reads the reserved internal flag.
#[tauri::command]
pub fn get_onboarding_complete(state: State<'_, AppState>) -> Result<bool, String> {
    let c = conn(&state)?;
    settings::get_onboarding_complete(&c)
}

/// Skip placement entirely: the learner chose "let me pick where to start".
/// We seed the foundational starting point (so the base concepts are unlocked
/// and there is somewhere to begin) and mark onboarding complete, WITHOUT any
/// mastery seeding beyond the unlocked base. The learner then picks an unlocked
/// concept from the curriculum diagram / browse list.
#[tauri::command]
pub fn skip_placement(state: State<'_, AppState>) -> Result<(), String> {
    let c = conn(&state)?;
    // Mastery 0.0: a pure cold start, just the gate opened on the base concept.
    seed_placement(&c, FOUNDATIONAL_ALGEBRA, 0.0)?;
    settings::set_onboarding_complete(&c, true)?;
    // Discard any half-generated placement quiz so a later real run regenerates.
    settings::set_placement_quiz(&c, "")?;
    Ok(())
}

/// The placement outcome returned to the frontend after grading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementResult {
    pub concept_id: String,
    pub domain: String,
    pub title: String,
    pub correct_count: i64,
    pub total: i64,
}

/// Grade the placement answers server-side, decide a starting concept, seed its
/// schedule + prerequisites so it is unlocked, and mark onboarding complete.
/// Objective questions are graded deterministically; any free_response is graded
/// by the model against its rubric (same path as `grade_quiz`).
#[tauri::command]
pub async fn place_learner(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
    answers: Vec<SubmittedAnswer>,
) -> Result<PlacementResult, String> {
    // Canonical questions from the server's own stored copy (NOT the frontend).
    let items: Vec<PlacementItem> = {
        let c = conn(&state)?;
        let raw = settings::get_placement_quiz(&c)?
            .ok_or("no placement quiz on record — generate one first")?;
        serde_json::from_str(&raw).map_err(|e| format!("read placement quiz: {e}"))?
    };

    // Does any answered free_response need a model grade?
    let needs_model = answers.iter().any(|a| {
        items
            .iter()
            .find(|it| it.question.id == a.question_id)
            .map(|it| grading::grade_objective(&it.question, &a.answer).is_none())
            .unwrap_or(false)
    });
    let key_and_model = if needs_model {
        let model = {
            let c = conn(&state)?;
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
                let raw = client::complete(&ai, k, m, &prompt).await?;
                let (score, _fb, ep) = client::parse_free_response_grade(&raw)?;
                grading::grade_free_response_from_score(&it.question, &a.answer, score, ep)
            }
        };
        if graded.is_correct {
            correct += 1;
        }
    }

    let target = decide_target(correct);
    let mastery = seed_mastery(correct);

    let (domain, title) = {
        let c = conn(&state)?;
        seed_placement(&c, target, mastery)?;
        settings::set_onboarding_complete(&c, true)?;
        // Clear the one-shot canonical placement quiz now that it is consumed.
        settings::set_placement_quiz(&c, "")?;
        c.query_row(
            "SELECT domain, title FROM concepts WHERE id = ?1 LIMIT 1",
            [target],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|e| format!("read placement target: {e}"))?
    };

    Ok(PlacementResult {
        concept_id: target.to_string(),
        domain,
        title,
        correct_count: correct as i64,
        total: answers.len() as i64,
    })
}

/// Seed the chosen target so it is reachable: set its starting mastery, and set
/// every (transitive) prerequisite to a mastered state so the gate opens. This
/// is a deliberate placement decision, NOT a learner attempt — attempt_count
/// stays 0 so the target still presents as fresh work.
fn seed_placement(conn: &rusqlite::Connection, target: &str, mastery: f64) -> Result<(), String> {
    // Unlock prerequisites transitively (the gate reads effective mastery on
    // EVERY prerequisite, including cross-domain). Seed them as completed.
    let prereqs = transitive_prerequisites(conn, target)?;
    for p in &prereqs {
        conn.execute(
            "UPDATE concepts SET mastery_score = MAX(mastery_score, 0.85), \
                last_correct = ?2, attempt_count = MAX(attempt_count, 1) \
             WHERE id = ?1",
            rusqlite::params![p, today_local()],
        )
        .map_err(|e| format!("seed prerequisite {p}: {e}"))?;
    }

    // Seed the target's starting mastery (attempt_count stays 0 → still "new").
    conn.execute(
        "UPDATE concepts SET mastery_score = ?2 WHERE id = ?1",
        rusqlite::params![target, mastery],
    )
    .map_err(|e| format!("seed target {target}: {e}"))?;
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
}
