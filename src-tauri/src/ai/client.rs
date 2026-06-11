//! Anthropic Messages API client (blocklist #2, #45, #46, #50).
//!
//! ONE `reqwest::Client` is built at startup and shared across every request
//! (stored in `AiState`); we NEVER construct a client per request. The API key
//! is read from the OS Keychain per request and not cached in memory longer
//! than the call. The model is ALWAYS read from settings via the typed
//! accessor — no call site hardcodes an id.
//!
//! The static system prompt is sent as a cached system block
//! (`cache_control: ephemeral`) on every request, since it is byte-identical
//! each time — a pure prompt-caching win.
//!
//! Errors are logged with `tracing` (never the key); callers surface a generic
//! message to the user.

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;

use super::models::ModelCache;
use super::prompt::SYSTEM_PROMPT;
use super::rate_limit::RateLimiter;

const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;

/// Shared AI state placed in Tauri app state: one HTTP client, the per-minute
/// rate limiter, and the model-list cache.
pub struct AiState {
    pub client: reqwest::Client,
    pub limiter: RateLimiter,
    pub model_cache: ModelCache,
}

impl AiState {
    /// Build the single shared client. Called once at startup.
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("build http client: {e}"))?;
        Ok(Self {
            client,
            limiter: RateLimiter::default(),
            model_cache: ModelCache::default(),
        })
    }
}

/// Build the JSON request body for a Messages call. The system prompt is a
/// cached block; `user_message` is the assembled (already-escaped) user turn.
fn request_body(model: &str, user_message: &str, stream: bool) -> serde_json::Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": stream,
        "system": [{
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": { "type": "ephemeral" }
        }],
        "messages": [{
            "role": "user",
            "content": user_message
        }]
    })
}

#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(default)]
    text: String,
}

/// Non-streaming completion (quiz, review, free_response grading). Returns the
/// concatenated text content. `model` MUST come from settings (never hardcoded).
pub async fn complete(
    state: &AiState,
    api_key: &str,
    model: &str,
    user_message: &str,
) -> Result<String, String> {
    state.limiter.check()?;
    let body = request_body(model, user_message, false);

    let resp = state
        .client
        .post(MESSAGES_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "messages request failed");
            "request to the model failed".to_string()
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        tracing::error!(%status, detail, "messages endpoint error");
        return Err(format!("the model returned an error ({status})"));
    }

    let parsed: MessagesResponse = resp.json().await.map_err(|e| {
        tracing::error!(error = %e, "messages parse failed");
        "could not read the model response".to_string()
    })?;

    Ok(parsed
        .content
        .into_iter()
        .map(|b| b.text)
        .collect::<String>())
}

/// Streaming completion (lesson, explain). Invokes `on_delta` for each text
/// chunk as it arrives so the UI can render incrementally, and returns the full
/// accumulated text. Parses the SSE `content_block_delta` events.
pub async fn complete_streaming<F: FnMut(&str)>(
    state: &AiState,
    api_key: &str,
    model: &str,
    user_message: &str,
    mut on_delta: F,
) -> Result<String, String> {
    state.limiter.check()?;
    let body = request_body(model, user_message, true);

    let resp = state
        .client
        .post(MESSAGES_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "stream request failed");
            "request to the model failed".to_string()
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        tracing::error!(%status, "stream endpoint error");
        return Err(format!("the model returned an error ({status})"));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            tracing::error!(error = %e, "stream read failed");
            "the model stream was interrupted".to_string()
        })?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        // SSE events are separated by blank lines; process complete lines.
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Some(text) = parse_delta_text(data) {
                    on_delta(&text);
                    full.push_str(&text);
                }
            }
        }
    }
    Ok(full)
}

/// Extract the text from a `content_block_delta` SSE data payload, if present.
fn parse_delta_text(data: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if v.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    Some(v.get("delta")?.get("text")?.as_str()?.to_string())
}

/// Connectivity test: send a TINY real request using the CONFIGURED model (never
/// a hardcoded id) and report success. This is the only place a real completion
/// is allowed for a "test"; the model picker uses GET /v1/models instead.
pub async fn test_connection(state: &AiState, api_key: &str, model: &str) -> Result<bool, String> {
    state.limiter.check()?;
    let body = json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }]
    });
    let resp = state
        .client
        .post(MESSAGES_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "test connection request failed");
            "could not reach the model".to_string()
        })?;
    Ok(resp.status().is_success())
}

/// Parse a free_response grade from the model's JSON reply: a structured
/// `{ "score": 0.0-1.0, "feedback": "...", "error_pattern": "..."|null }`.
/// Returns (score, feedback, error_pattern).
pub fn parse_free_response_grade(raw: &str) -> Result<(f64, String, Option<String>), String> {
    // Tolerate a markdown code fence around the JSON.
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let v: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("grade is not valid JSON: {e}"))?;
    let score = v
        .get("score")
        .and_then(serde_json::Value::as_f64)
        .ok_or("grade missing numeric score")?
        .clamp(0.0, 1.0);
    let feedback = v
        .get("feedback")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let error_pattern = v
        .get("error_pattern")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((score, feedback, error_pattern))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The system prompt is sent as a cached block on every request.
    #[test]
    fn request_body_caches_system_block() {
        let body = request_body("claude-sonnet-4-6", "<mode>quiz</mode>", false);
        let sys = &body["system"][0];
        assert_eq!(sys["cache_control"]["type"], "ephemeral");
        assert!(sys["text"].as_str().unwrap().contains("You are Etta"));
        assert_eq!(body["model"], "claude-sonnet-4-6");
    }

    #[test]
    fn parses_streaming_delta() {
        let data = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}"#;
        assert_eq!(parse_delta_text(data).as_deref(), Some("hi"));
        // A non-delta event yields nothing.
        assert!(parse_delta_text(r#"{"type":"message_start"}"#).is_none());
    }

    #[test]
    fn parses_free_response_grade() {
        let raw = r#"{"score":0.8,"feedback":"good","error_pattern":null}"#;
        let (score, fb, ep) = parse_free_response_grade(raw).unwrap();
        assert!((score - 0.8).abs() < 1e-9);
        assert_eq!(fb, "good");
        assert!(ep.is_none());
    }
}
