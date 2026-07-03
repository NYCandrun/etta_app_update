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

/// Current fallback model ids (undated aliases). NONE are dated/legacy ids,
/// and the list ALWAYS contains a Sonnet so `pick_default_model` resolves a
/// sensible offline default when GET /v1/models is unreachable.
pub const FALLBACK_MODELS: &[&str] = &["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];

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
    /// RFC3339 creation timestamp from GET /v1/models (present in practice;
    /// tolerated as absent so a schema change never breaks the picker).
    #[serde(default)]
    created_at: Option<String>,
    /// Human-friendly label (captured off the wire for completeness; the
    /// picker renders ids, so this is not read back yet).
    #[serde(default)]
    #[allow(dead_code)]
    display_name: Option<String>,
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

/// Force a fetch of the model list, BYPASSING the fresh-cache check, and
/// SURFACE any failure to the caller. This is the manual "Refresh" path: unlike
/// the passive `list_available_models` (which silently falls back to the
/// hardcoded list), the user asked for a re-fetch, so a missing key / network /
/// parse error / empty list becomes a friendly `Err` they can see and act on.
/// On success the fresh, newest-first id list is stored in the cache.
pub async fn refresh_available_models(
    client: &reqwest::Client,
    cache: &ModelCache,
    api_key: Option<&str>,
) -> Result<Vec<String>, String> {
    let Some(key) = api_key else {
        return Err("add your API key first to fetch the model list".to_string());
    };
    match fetch_models(client, key).await {
        Ok(ids) if !ids.is_empty() => {
            cache.store(ids.clone());
            Ok(ids)
        }
        Ok(_) => Err("your account returned no available models".to_string()),
        Err(e) => {
            tracing::warn!(error = %e, "refresh_available_models fetch failed");
            Err("could not refresh the model list — check your key and connection".to_string())
        }
    }
}

/// Pick a sensible default base model from a NEWEST-FIRST id list: the newest
/// id whose (lowercased) id contains "sonnet"; if none is a Sonnet, the newest
/// id overall; None only when the list is empty. Because the list is already
/// sorted newest-first, "the first sonnet" IS the newest sonnet.
pub fn pick_default_model(ids: &[String]) -> Option<String> {
    ids.iter()
        .find(|id| id.to_lowercase().contains("sonnet"))
        .or_else(|| ids.first())
        .cloned()
}

/// Sort model entries NEWEST-FIRST by `created_at` (RFC3339, which sorts
/// correctly lexicographically), descending. A missing timestamp sorts LAST,
/// with the id as a stable tiebreaker. Returns the ids in that order.
fn sort_ids_newest_first(mut entries: Vec<ModelEntry>) -> Vec<String> {
    entries.sort_by(|a, b| {
        // None must sort AFTER any Some (dated) entry: map None → "" and
        // compare with Some first. We compare (has_date, created_at) so
        // present timestamps win, then reverse for DESC.
        let key = |m: &ModelEntry| (m.created_at.is_some(), m.created_at.clone().unwrap_or_default());
        key(b)
            .cmp(&key(a))
            .then_with(|| a.id.cmp(&b.id))
    });
    entries.into_iter().map(|m| m.id).collect()
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
    // Always return the ids newest-first so `pick_default_model` (and the
    // Settings dropdown) see the most recent releases at the top.
    Ok(sort_ids_newest_first(parsed.data))
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

    /// The offline fallback list MUST contain a Sonnet so `pick_default_model`
    /// resolves the intended "most recent Sonnet" default even when GET
    /// /v1/models is unreachable (first setup while briefly offline).
    #[test]
    fn fallback_list_has_a_sonnet() {
        assert!(
            FALLBACK_MODELS
                .iter()
                .any(|id| id.to_lowercase().contains("sonnet")),
            "fallback list must contain a sonnet for the offline default"
        );
        // And that sonnet is what pick_default_model chooses from the fallback.
        let ids: Vec<String> = FALLBACK_MODELS.iter().map(|s| s.to_string()).collect();
        assert_eq!(pick_default_model(&ids).as_deref(), Some("claude-sonnet-5"));
    }

    /// `pick_default_model` on a NEWEST-FIRST list: the first (newest) Sonnet
    /// wins; with no Sonnet the newest id overall wins; empty → None.
    #[test]
    fn pick_default_model_prefers_newest_sonnet() {
        // Newest-first: two Sonnets present → the FIRST (newest) one is chosen,
        // never Opus/Haiku even though they may be newer or older siblings.
        let mixed = vec![
            "claude-opus-4-8".to_string(),
            "claude-sonnet-5".to_string(), // newest sonnet
            "claude-sonnet-4-6".to_string(),
            "claude-haiku-4-5".to_string(),
        ];
        assert_eq!(
            pick_default_model(&mixed).as_deref(),
            Some("claude-sonnet-5")
        );

        // No sonnet anywhere → the newest id overall (list head).
        let sonnetless = vec![
            "claude-opus-4-8".to_string(),
            "claude-haiku-4-5".to_string(),
        ];
        assert_eq!(
            pick_default_model(&sonnetless).as_deref(),
            Some("claude-opus-4-8")
        );

        // Empty list → no default.
        assert_eq!(pick_default_model(&[]), None);

        // Case-insensitive match on the id substring.
        let cased = vec!["Claude-SONNET-Next".to_string()];
        assert_eq!(
            pick_default_model(&cased).as_deref(),
            Some("Claude-SONNET-Next")
        );
    }

    /// The fetch sort helper (factored out so it is testable WITHOUT any
    /// network call): entries come back NEWEST-FIRST by `created_at` (RFC3339
    /// DESC); a missing timestamp sorts LAST; ids break ties. Feeding the
    /// SORTED ids to `pick_default_model` then yields the newest sonnet.
    #[test]
    fn fetch_sort_orders_newest_first_and_feeds_the_picker() {
        let entry = |id: &str, created: Option<&str>| ModelEntry {
            id: id.to_string(),
            created_at: created.map(str::to_string),
            display_name: None,
        };
        // Deliberately UNSORTED input (as an API might return it).
        let unsorted = vec![
            entry("claude-sonnet-4-6", Some("2025-01-01T00:00:00Z")),
            entry("claude-opus-4-8", Some("2026-03-01T00:00:00Z")),
            entry("claude-sonnet-5", Some("2026-06-01T00:00:00Z")), // newest sonnet
            entry("claude-legacy-undated", None),                   // no date → last
        ];
        let ids = sort_ids_newest_first(unsorted);
        assert_eq!(
            ids,
            vec![
                "claude-sonnet-5".to_string(),
                "claude-opus-4-8".to_string(),
                "claude-sonnet-4-6".to_string(),
                "claude-legacy-undated".to_string(),
            ],
            "newest-first by created_at DESC, undated last"
        );
        // The picker over the sorted ids selects the newest sonnet.
        assert_eq!(pick_default_model(&ids).as_deref(), Some("claude-sonnet-5"));
    }

    /// Ties on `created_at` (or both undated) fall back to the id as a stable
    /// ordering key, so the list is deterministic.
    #[test]
    fn fetch_sort_breaks_ties_by_id() {
        let entry = |id: &str, created: Option<&str>| ModelEntry {
            id: id.to_string(),
            created_at: created.map(str::to_string),
            display_name: None,
        };
        let same_date = vec![
            entry("bbb", Some("2026-01-01T00:00:00Z")),
            entry("aaa", Some("2026-01-01T00:00:00Z")),
        ];
        assert_eq!(sort_ids_newest_first(same_date), vec!["aaa", "bbb"]);
    }
}
