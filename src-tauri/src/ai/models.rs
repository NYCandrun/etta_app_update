//! Available-model listing for the Settings picker (blocklist #50).
//!
//! `list_available_models` fetches ids from Anthropic's GET /v1/models — a
//! cheap metadata endpoint. It NEVER burns a real completion request to probe
//! connectivity (v1 sent a "Reply with OK" completion every time — forbidden).
//! The result is cached in memory; on any network/parse failure we fall back to
//! a hardcoded CURRENT list (no stale dated ids).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Current June-2026 fallback model ids. NONE are dated/legacy ids.
pub const FALLBACK_MODELS: &[&str] = &["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"];

const MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Re-fetch the model list at most this often.
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// In-memory cache of the model id list.
#[derive(Default)]
pub struct ModelCache {
    inner: Mutex<Option<(Instant, Vec<String>)>>,
}

impl ModelCache {
    fn get_fresh(&self) -> Option<Vec<String>> {
        let guard = self.inner.lock().ok()?;
        let (at, ids) = guard.as_ref()?;
        (at.elapsed() < CACHE_TTL).then(|| ids.clone())
    }

    fn store(&self, ids: Vec<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some((Instant::now(), ids));
        }
    }
}

/// Return the list of model ids for the Settings picker. Served from cache when
/// fresh; otherwise fetches GET /v1/models. On any failure, returns the
/// hardcoded current fallback list — and makes ZERO completion requests on
/// either path.
pub async fn list_available_models(
    client: &reqwest::Client,
    cache: &ModelCache,
    api_key: Option<&str>,
) -> Vec<String> {
    if let Some(ids) = cache.get_fresh() {
        return ids;
    }

    let fallback = || FALLBACK_MODELS.iter().map(|s| s.to_string()).collect();

    let Some(key) = api_key else {
        // No key → can't call the metadata endpoint; use the fallback.
        return fallback();
    };

    match fetch_models(client, key).await {
        Ok(ids) if !ids.is_empty() => {
            cache.store(ids.clone());
            ids
        }
        Ok(_) => fallback(),
        Err(e) => {
            tracing::warn!(error = %e, "list_available_models fetch failed; using fallback");
            fallback()
        }
    }
}

async fn fetch_models(client: &reqwest::Client, api_key: &str) -> Result<Vec<String>, String> {
    let resp = client
        .get(MODELS_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .map_err(|e| format!("models request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("models endpoint returned {}", resp.status()));
    }
    let parsed: ModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("models parse failed: {e}"))?;
    Ok(parsed.data.into_iter().map(|m| m.id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_list_has_no_dated_ids() {
        for id in FALLBACK_MODELS {
            // A dated legacy id looks like "claude-...-YYYYMMDD".
            let tail = id.rsplit('-').next().unwrap();
            assert!(
                !(tail.len() == 8 && tail.chars().all(|c| c.is_ascii_digit())),
                "fallback model {id} looks like a dated/legacy id"
            );
        }
    }
}
