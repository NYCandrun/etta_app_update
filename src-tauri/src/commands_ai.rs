//! AI + curriculum Tauri command surface (milestone 2).
//!
//! Every command that calls the model: (1) reads the API key from the keychain
//! per request (never cached longer than the call), (2) reads the configured
//! model from settings via the typed accessor (no hardcoded id), (3) consults
//! the content cache before any network call and stores clean JSON on a miss,
//! and (4) grades SERVER-side from the canonical question JSON. Streaming modes
//! (lesson, explain) emit incremental `ai://delta` events.
//!
//! Detailed failures go to `tracing`; the frontend receives generic errors.

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::ai::prompt::{build_user_message, ConceptContext, LearnerContext, Mode, Strategy};
use crate::ai::{client, mastery_band, models, AiState};
use crate::contract::{GradedAnswer, Question};
use crate::db::AppState;
use crate::{cache, grading, keychain, settings, validate};

/// Lock the shared connection (poisoned mutex → generic error).
fn conn<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state
        .db
        .lock()
        .map_err(|_| "internal db lock error".to_string())
}

/// Read the stored key or fail with a generic, user-facing message.
fn require_key() -> Result<String, String> {
    match keychain::get_key()? {
        Some(k) if !k.trim().is_empty() => Ok(k),
        _ => Err("no API key configured".to_string()),
    }
}

/// Curriculum + learner fields for one concept, read in a single bounded query.
struct ConceptRow {
    ctx: ConceptContext,
    learner: LearnerContext,
    mastery_score: f64,
}

/// The raw columns read for one concept, before JSON arrays are parsed.
struct RawConceptColumns {
    title: String,
    domain: String,
    module: String,
    difficulty_tier: Option<i64>,
    objectives_json: String,
    patterns_json: String,
    mastery_score: f64,
    attempt_count: i64,
    streak_correct: i64,
    ease_factor: f64,
    last_latency_ms: Option<i64>,
}

/// Load one concept's curriculum fields and learner state from the `concepts`
/// table. JSON array columns are parsed into Vecs.
fn load_concept(conn: &rusqlite::Connection, concept_id: &str) -> Result<ConceptRow, String> {
    let raw = conn
        .query_row(
            "SELECT title, domain, module, difficulty_tier, learning_objectives, \
                    error_patterns, mastery_score, attempt_count, streak_correct, \
                    ease_factor, last_latency_ms \
             FROM concepts WHERE id = ?1 LIMIT 1",
            [concept_id],
            |r| {
                Ok(RawConceptColumns {
                    title: r.get(0)?,
                    domain: r.get(1)?,
                    module: r.get(2)?,
                    difficulty_tier: r.get(3)?,
                    objectives_json: r.get(4)?,
                    patterns_json: r.get(5)?,
                    mastery_score: r.get(6)?,
                    attempt_count: r.get(7)?,
                    streak_correct: r.get(8)?,
                    ease_factor: r.get(9)?,
                    last_latency_ms: r.get(10)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("unknown concept {concept_id}"),
            other => {
                tracing::error!(error = %other, "load concept failed");
                "could not read the concept".to_string()
            }
        })?;

    let learning_objectives: Vec<String> =
        serde_json::from_str(&raw.objectives_json).unwrap_or_default();
    let error_patterns: Vec<String> = serde_json::from_str(&raw.patterns_json).unwrap_or_default();

    Ok(ConceptRow {
        ctx: ConceptContext {
            id: concept_id.to_string(),
            title: raw.title,
            domain: raw.domain,
            module: raw.module,
            difficulty_tier: raw.difficulty_tier.unwrap_or(1),
            learning_objectives,
            error_patterns,
        },
        learner: LearnerContext {
            mastery_score: raw.mastery_score,
            attempt_count: raw.attempt_count,
            streak_correct: raw.streak_correct,
            ease_factor: raw.ease_factor,
            last_latency_ms: raw.last_latency_ms,
        },
        mastery_score: raw.mastery_score,
    })
}

/// Parse the optional explain strategy tag into the enum (defaults to textbook).
fn parse_strategy(s: Option<&str>) -> Strategy {
    match s {
        Some("analogy") => Strategy::Analogy,
        Some("socratic") => Strategy::Socratic,
        Some("scaffold") => Strategy::Scaffold,
        _ => Strategy::Textbook,
    }
}

// ---- Model picker ----

/// List model ids for the Settings picker. Uses GET /v1/models (cached); falls
/// back to the current hardcoded list on any failure. Makes ZERO completion
/// requests. The key is optional — without it we return the fallback list.
#[tauri::command]
pub async fn list_available_models(ai: State<'_, AiState>) -> Result<Vec<String>, String> {
    let key = keychain::get_key()?;
    Ok(models::list_available_models(&ai.client, &ai.model_cache, key.as_deref()).await)
}

/// Real connectivity test: a tiny completion using the CONFIGURED model (never a
/// hardcoded id). Returns true on a 2xx, false otherwise.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
) -> Result<bool, String> {
    let key = require_key()?;
    let model = {
        let c = conn(&state)?;
        settings::base_model(&c)?
    };
    client::test_connection(&ai, &key, &model).await
}

// ---- Lesson / Explain (streaming) ----

/// A streamed AI turn: emits `ai://delta` events as chunks arrive and returns the
/// full text. `mode` is "lesson" or "explain". The result is cached as clean
/// JSON (a `{ "text": ... }` object) keyed by concept + content_type.
#[tauri::command]
pub async fn generate_streamed(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
    window: tauri::Window,
    concept_id: String,
    mode: String,
    strategy: Option<String>,
    user_input: Option<String>,
) -> Result<String, String> {
    validate::concept_id(&concept_id)?;
    let (mode_enum, content_type) = match mode.as_str() {
        "lesson" => (Mode::Lesson, "lesson"),
        "explain" => (Mode::Explain, "explain"),
        other => return Err(format!("generate_streamed: unsupported mode {other:?}")),
    };
    if let Some(ref u) = user_input {
        validate::string_len("user_input", u, 4000)?;
    }

    // Cache check (explain with user input is conversational → skip cache).
    let band = {
        let c = conn(&state)?;
        let row = load_concept(&c, &concept_id)?;
        let band = mastery_band(row.mastery_score).to_string();
        // For a plain lesson (no user input) try the cache first.
        if user_input
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            if let Some(hit) = cache::get(&c, &concept_id, content_type)? {
                if let Some(text) = extract_cached_text(&hit.payload_json) {
                    // Replay cached text as a single delta so the UI renders it.
                    let _ = window.emit("ai://delta", &text);
                    return Ok(text);
                }
            }
        }
        band
    };

    let key = require_key()?;
    let (model, user_message) = {
        let c = conn(&state)?;
        let model = settings::base_model(&c)?;
        let row = load_concept(&c, &concept_id)?;
        let strat = (mode_enum == Mode::Explain).then(|| parse_strategy(strategy.as_deref()));
        let msg = build_user_message(
            mode_enum,
            strat,
            &row.ctx,
            &row.learner,
            user_input.as_deref(),
        );
        (model, msg)
    };

    let win = window.clone();
    let full = client::complete_streaming(&ai, &key, &model, &user_message, move |delta| {
        let _ = win.emit("ai://delta", delta);
    })
    .await?;

    // Cache the plain lesson (clean JSON; metadata in side-band columns).
    if user_input
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        let payload = serde_json::json!({ "text": full }).to_string();
        let c = conn(&state)?;
        if let Err(e) = cache::put(
            &c,
            &concept_id,
            content_type,
            &payload,
            Some(&band),
            Some(&model),
        ) {
            tracing::warn!(error = %e, "cache put (streamed) failed");
        }
    }

    Ok(full)
}

/// Pull the `text` field out of a cached `{ "text": ... }` payload.
fn extract_cached_text(payload_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload_json).ok()?;
    v.get("text")?.as_str().map(str::to_string)
}

// ---- Quiz (non-streaming, cached) ----

/// Generate (or serve from cache) a quiz for a concept. Returns the validated,
/// schema-repaired list of questions as clean JSON. The canonical question JSON
/// (including each option's `isCorrect`) is what the grader later trusts.
#[tauri::command]
pub async fn generate_quiz(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
    concept_id: String,
) -> Result<Vec<Question>, String> {
    validate::concept_id(&concept_id)?;

    let band = {
        let c = conn(&state)?;
        let row = load_concept(&c, &concept_id)?;
        let band = mastery_band(row.mastery_score).to_string();
        if let Some(hit) = cache::get(&c, &concept_id, "quiz")? {
            // The cached payload is the clean questions JSON array; re-validate.
            if let Ok(qs) = crate::ai::quiz_schema::parse_and_repair(&hit.payload_json) {
                return Ok(qs);
            }
            tracing::warn!(concept_id, "cached quiz failed re-validation; regenerating");
        }
        band
    };

    let key = require_key()?;
    let (model, user_message) = {
        let c = conn(&state)?;
        let model = settings::base_model(&c)?;
        let row = load_concept(&c, &concept_id)?;
        let msg = build_user_message(Mode::Quiz, None, &row.ctx, &row.learner, None);
        (model, msg)
    };

    let raw = client::complete(&ai, &key, &model, &user_message).await?;
    let questions = crate::ai::quiz_schema::parse_and_repair(&raw)?;

    // Store the canonical (re-serialized clean) JSON so grading trusts our shape.
    let payload = serde_json::to_string(&questions).map_err(|e| format!("serialize quiz: {e}"))?;
    {
        let c = conn(&state)?;
        if let Err(e) = cache::put(&c, &concept_id, "quiz", &payload, Some(&band), Some(&model)) {
            tracing::warn!(error = %e, "cache put (quiz) failed");
        }
    }

    Ok(questions)
}

// ---- Grading (server-authoritative) ----

/// One submitted answer (the frontend sends only the question id and the raw
/// answer string — NEVER a correctness flag).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedAnswer {
    pub question_id: String,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeQuizResult {
    pub answers: Vec<GradedAnswer>,
    pub final_score: f64,
}

/// Grade a whole quiz server-side. The canonical questions come from the content
/// cache (the same clean JSON `generate_quiz` stored) — NOT from the frontend.
/// multiple_choice / fill_in_blank are graded deterministically in Rust;
/// free_response is graded by the model against its rubric.
#[tauri::command]
pub async fn grade_quiz(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
    concept_id: String,
    answers: Vec<SubmittedAnswer>,
) -> Result<GradeQuizResult, String> {
    validate::concept_id(&concept_id)?;

    // Canonical questions from the cache (server's own stored copy).
    let questions: Vec<Question> = {
        let c = conn(&state)?;
        let hit =
            cache::get(&c, &concept_id, "quiz")?.ok_or("no quiz to grade for this concept")?;
        crate::ai::quiz_schema::parse_and_repair(&hit.payload_json)?
    };

    // Resolve any free_response questions that need a model call.
    let key_and_model = {
        let needs_model = answers.iter().any(|a| {
            questions
                .iter()
                .find(|q| q.id == a.question_id)
                .map(|q| grading::grade_objective(q, &a.answer).is_none())
                .unwrap_or(false)
        });
        if needs_model {
            let model = {
                let c = conn(&state)?;
                settings::base_model(&c)?
            };
            Some((require_key()?, model))
        } else {
            None
        }
    };

    let mut graded = Vec::with_capacity(answers.len());
    for a in &answers {
        let Some(q) = questions.iter().find(|q| q.id == a.question_id) else {
            return Err(format!(
                "answer references unknown question {:?}",
                a.question_id
            ));
        };

        let g = match grading::grade_objective(q, &a.answer) {
            Some(objective) => objective,
            None => {
                // free_response: grade against the rubric via the model.
                let (key, model) = key_and_model
                    .as_ref()
                    .ok_or("internal: free_response needs a model")?;
                let rubric = q.rubric.as_deref().unwrap_or("Grade for correctness.");
                let grading_prompt = build_grading_prompt(&q.prompt, rubric, &a.answer);
                let raw = client::complete(&ai, key, model, &grading_prompt).await?;
                let (score, _feedback, error_pattern) = client::parse_free_response_grade(&raw)?;
                grading::grade_free_response_from_score(q, &a.answer, score, error_pattern)
            }
        };
        graded.push(g);
    }

    let final_score = if graded.is_empty() {
        0.0
    } else {
        graded.iter().map(|g| g.score).sum::<f64>() / graded.len() as f64
    };

    Ok(GradeQuizResult {
        answers: graded,
        final_score,
    })
}

/// Build the free_response grading turn. The learner's answer and the rubric are
/// escaped (the answer is untrusted input; #41). Asks for the structured JSON
/// `client::parse_free_response_grade` expects.
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

// ---- Concept reads (curriculum) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptSummary {
    pub id: String,
    pub domain: String,
    pub module: String,
    pub title: String,
    pub difficulty_tier: i64,
}

/// List concepts, optionally filtered to one domain. Bounded query; ordered by
/// id so module/concept ordering is stable.
#[tauri::command]
pub fn list_concepts(
    state: State<'_, AppState>,
    domain: Option<String>,
) -> Result<Vec<ConceptSummary>, String> {
    let c = conn(&state)?;
    let mut out = Vec::new();
    if let Some(d) = domain {
        validate::string_len("domain", &d, 64)?;
        let mut stmt = c
            .prepare(
                "SELECT id, domain, module, title, COALESCE(difficulty_tier, 1) \
                 FROM concepts WHERE domain = ?1 ORDER BY id LIMIT 1000",
            )
            .map_err(|e| format!("prepare list_concepts: {e}"))?;
        let rows = stmt
            .query_map([d], map_concept_summary)
            .map_err(|e| format!("query list_concepts: {e}"))?;
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
    } else {
        let mut stmt = c
            .prepare(
                "SELECT id, domain, module, title, COALESCE(difficulty_tier, 1) \
                 FROM concepts ORDER BY id LIMIT 1000",
            )
            .map_err(|e| format!("prepare list_concepts: {e}"))?;
        let rows = stmt
            .query_map([], map_concept_summary)
            .map_err(|e| format!("query list_concepts: {e}"))?;
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
    }
    Ok(out)
}

fn map_concept_summary(r: &rusqlite::Row) -> rusqlite::Result<ConceptSummary> {
    Ok(ConceptSummary {
        id: r.get(0)?,
        domain: r.get(1)?,
        module: r.get(2)?,
        title: r.get(3)?,
        difficulty_tier: r.get(4)?,
    })
}
