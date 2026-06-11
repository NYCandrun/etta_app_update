//! Per-minute API rate limiter (blocklist #45).
//!
//! A runaway loop (e.g. a buggy retry) must never silently drain API credits.
//! This is a fixed-window counter: at most `MAX_PER_MIN` requests per rolling
//! 60-second window. Over the limit, `check` returns a typed error so the caller
//! surfaces "rate limited, retry shortly" — it NEVER silently spins.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// ~30 requests/min ceiling (the runbook's guidance).
const MAX_PER_MIN: usize = 30;
const WINDOW: Duration = Duration::from_secs(60);

/// Sliding-window limiter. Stored in app state and shared across requests.
pub struct RateLimiter {
    hits: Mutex<VecDeque<Instant>>,
    max: usize,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(MAX_PER_MIN)
    }
}

impl RateLimiter {
    pub fn new(max: usize) -> Self {
        Self {
            hits: Mutex::new(VecDeque::new()),
            max,
        }
    }

    /// Record one request if under the limit. Returns a typed error otherwise.
    /// Uses a monotonic clock so it is immune to wall-clock changes.
    pub fn check(&self) -> Result<(), String> {
        self.check_at(Instant::now())
    }

    fn check_at(&self, now: Instant) -> Result<(), String> {
        let mut hits = self
            .hits
            .lock()
            .map_err(|_| "rate limiter lock error".to_string())?;
        // Drop entries older than the window.
        while let Some(front) = hits.front() {
            if now.duration_since(*front) >= WINDOW {
                hits.pop_front();
            } else {
                break;
            }
        }
        if hits.len() >= self.max {
            return Err("rate limited, retry shortly".to_string());
        }
        hits.push_back(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The (N+1)th request inside the window is rejected with the typed error,
    /// and the window expiring lets requests through again.
    #[test]
    fn rejects_over_limit_then_recovers() {
        let rl = RateLimiter::new(3);
        let t0 = Instant::now();
        assert!(rl.check_at(t0).is_ok());
        assert!(rl.check_at(t0).is_ok());
        assert!(rl.check_at(t0).is_ok());
        let err = rl.check_at(t0).unwrap_err();
        assert_eq!(err, "rate limited, retry shortly");

        // After the window passes, the old hits expire and we can proceed.
        let later = t0 + WINDOW + Duration::from_millis(1);
        assert!(rl.check_at(later).is_ok());
    }
}
