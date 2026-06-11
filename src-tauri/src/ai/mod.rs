//! AI layer: shared HTTP client, prompt assembly, model listing, rate limiting,
//! streaming, and cache-integrated content generation.
//!
//! The single `reqwest::Client` lives in `AiState` (built once at startup). The
//! configured model always comes from settings (`settings::base_model`). The
//! content cache is consulted before any call and populated on a miss via the
//! data layer (clean JSON; side-band metadata in its own columns — never by
//! string concatenation).

pub mod client;
pub mod models;
pub mod prompt;
pub mod quiz_schema;
pub mod rate_limit;

pub use client::AiState;

/// Map a learner's mastery score to the cache's coarse band (side-band column).
pub fn mastery_band(mastery_score: f64) -> &'static str {
    if mastery_score < 0.3 {
        "low"
    } else if mastery_score <= 0.6 {
        "mid"
    } else {
        "high"
    }
}
