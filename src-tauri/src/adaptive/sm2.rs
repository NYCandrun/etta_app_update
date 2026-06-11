//! SM-2 spaced-repetition scheduling (Appendix E, implemented EXACTLY).
//!
//! v1's SM-2 had no ease CAP and an unbounded interval; here the ease factor is
//! clamped to `[1.3, 3.5]` and the interval is capped at 180 days. These bounds
//! are enforced at every site that bumps the ease or interval (blocklist 7.x).
//!
//! - ease starts at 2.5; Easy `+0.1` (cap 3.5); Hard/Failed `-0.2` (floor 1.3).
//! - Failed resets the interval to 1 day; otherwise interval grows
//!   multiplicatively by the (post-update) ease, then is capped at 180 days.
//! - Initial steps: a concept on its first successful pass moves 1 day → 6 days
//!   before the multiplicative growth kicks in.

/// Ease floor (Appendix E).
pub const MIN_EASE_FACTOR: f64 = 1.3;
/// Ease CAP — v1 had none; we never let ease exceed this (Appendix E).
pub const MAX_EASE_FACTOR: f64 = 3.5;
/// Interval is never scheduled beyond this many days (Appendix E).
pub const MAX_INTERVAL_DAYS: i64 = 180;
/// Initial interval after the first successful review (the "1 → 6" graduation).
pub const SECOND_INTERVAL_DAYS: i64 = 6;
/// A concept not reviewed within this many days is force-scheduled for review.
pub const FORCE_REVIEW_DAYS: i64 = 60;
/// Mastery below this re-enters the active queue even if not yet due.
pub const REENTRY_MASTERY: f64 = 0.6;

/// The learner's graded performance on a review, mapped to SM-2 quality.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseQuality {
    Failed,
    Hard,
    Good,
    Easy,
}

/// The result of an SM-2 update: the new ease, new interval (days), and the next
/// review date (`YYYY-MM-DD`).
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleUpdate {
    pub ease_factor: f64,
    pub interval_days: i64,
    pub next_review: String,
}

/// Apply the SM-2 update for one review (Appendix E, verbatim semantics).
///
/// `current_interval` is the interval BEFORE this review. The "1 → 6 → ×ease"
/// graduation is handled here: a Good/Easy result on a concept still at the
/// initial 1-day interval advances to 6 days before multiplicative growth.
pub fn update_schedule(
    quality: ResponseQuality,
    current_ease: f64,
    current_interval: i64,
) -> ScheduleUpdate {
    let (new_ease, new_interval) = match quality {
        ResponseQuality::Failed => {
            let ease = (current_ease - 0.2).max(MIN_EASE_FACTOR);
            (ease, 1)
        }
        ResponseQuality::Hard => {
            let ease = (current_ease - 0.2).max(MIN_EASE_FACTOR);
            let interval = grow_interval(current_interval, ease);
            (ease, interval.max(1))
        }
        ResponseQuality::Good => {
            let interval = grow_interval(current_interval, current_ease);
            (current_ease, interval.max(1))
        }
        ResponseQuality::Easy => {
            let ease = (current_ease + 0.1).min(MAX_EASE_FACTOR);
            let interval = grow_interval(current_interval, ease);
            (ease, interval.max(1))
        }
    };

    let new_interval = new_interval.min(MAX_INTERVAL_DAYS);
    ScheduleUpdate {
        ease_factor: new_ease,
        interval_days: new_interval,
        next_review: compute_next_review_date(new_interval),
    }
}

/// Grow the interval for a successful (Hard/Good/Easy) review. Implements the
/// initial 1 → 6 graduation step before switching to multiplicative growth.
fn grow_interval(current_interval: i64, ease: f64) -> i64 {
    if current_interval <= 1 {
        SECOND_INTERVAL_DAYS
    } else {
        ((current_interval as f64) * ease).round() as i64
    }
}

/// Classify a graded response into an SM-2 quality (Appendix E).
/// `slow_threshold_ms` scales with difficulty tier (NOT a fixed 30s) — see
/// `slow_threshold_for_tier`.
pub fn classify_response(
    correct: bool,
    streak: i64,
    latency_ms: Option<i64>,
    slow_threshold_ms: i64,
) -> ResponseQuality {
    if !correct {
        return ResponseQuality::Failed;
    }
    if streak >= 3 {
        return ResponseQuality::Easy;
    }
    if let Some(ms) = latency_ms {
        if ms > slow_threshold_ms {
            return ResponseQuality::Hard;
        }
    }
    ResponseQuality::Good
}

/// Per-tier "slow/hard" latency threshold in milliseconds. Harder concepts
/// (higher tier) are allowed more thinking time before a correct-but-slow answer
/// is treated as Hard. Base 20s at tier 1, +10s per tier (tier 5 → 60s). This
/// replaces v1's fixed 30s threshold (blocklist #3).
pub fn slow_threshold_for_tier(difficulty_tier: i64) -> i64 {
    let tier = difficulty_tier.clamp(1, 5);
    (20_000 + (tier - 1) * 10_000).max(20_000)
}

/// `today + interval_days` as `YYYY-MM-DD` (local date, per Appendix E).
fn compute_next_review_date(interval_days: i64) -> String {
    let today = chrono::Local::now().date_naive();
    (today + chrono::Duration::days(interval_days))
        .format("%Y-%m-%d")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Required gating test: failing resets interval to 1 and drops ease by 0.2
    /// (floored 1.3); easy raises ease by 0.1 (capped 3.5); interval never
    /// exceeds 180 days.
    #[test]
    fn sm2_failed_resets_and_drops_ease() {
        let u = update_schedule(ResponseQuality::Failed, 2.5, 30);
        assert_eq!(u.interval_days, 1, "failed resets interval to 1");
        assert!(
            (u.ease_factor - 2.3).abs() < 1e-9,
            "failed drops ease by 0.2"
        );
    }

    #[test]
    fn sm2_ease_floor_enforced() {
        // Repeatedly failing must never push ease below the 1.3 floor.
        let u = update_schedule(ResponseQuality::Failed, 1.35, 10);
        assert!(u.ease_factor >= MIN_EASE_FACTOR);
        assert!((u.ease_factor - MIN_EASE_FACTOR).abs() < 1e-9);
    }

    #[test]
    fn sm2_easy_raises_ease_capped() {
        let u = update_schedule(ResponseQuality::Easy, 2.5, 6);
        assert!(
            (u.ease_factor - 2.6).abs() < 1e-9,
            "easy raises ease by 0.1"
        );

        // At the cap, an easy review must NOT exceed 3.5 (v1 had no cap).
        let capped = update_schedule(ResponseQuality::Easy, 3.45, 6);
        assert!(capped.ease_factor <= MAX_EASE_FACTOR);
        assert!((capped.ease_factor - MAX_EASE_FACTOR).abs() < 1e-9);
    }

    #[test]
    fn sm2_interval_capped_at_180() {
        // A long-running Good streak must never schedule beyond 180 days.
        let mut interval = 120;
        let ease = 3.0;
        for _ in 0..10 {
            let u = update_schedule(ResponseQuality::Good, ease, interval);
            interval = u.interval_days;
            assert!(
                u.interval_days <= MAX_INTERVAL_DAYS,
                "interval {} exceeded cap",
                u.interval_days
            );
        }
        assert_eq!(interval, MAX_INTERVAL_DAYS);
    }

    #[test]
    fn sm2_initial_graduation_one_to_six() {
        // First successful (Good) review at interval 1 graduates to 6 days.
        let u = update_schedule(ResponseQuality::Good, 2.5, 1);
        assert_eq!(u.interval_days, SECOND_INTERVAL_DAYS);
        // Then multiplicative growth: 6 * 2.5 = 15.
        let u2 = update_schedule(ResponseQuality::Good, 2.5, u.interval_days);
        assert_eq!(u2.interval_days, 15);
    }

    #[test]
    fn classify_maps_quality() {
        assert_eq!(
            classify_response(false, 5, Some(100), 20_000),
            ResponseQuality::Failed
        );
        assert_eq!(
            classify_response(true, 3, Some(100), 20_000),
            ResponseQuality::Easy
        );
        assert_eq!(
            classify_response(true, 1, Some(99_999), 20_000),
            ResponseQuality::Hard
        );
        assert_eq!(
            classify_response(true, 1, Some(100), 20_000),
            ResponseQuality::Good
        );
    }

    #[test]
    fn slow_threshold_scales_with_tier() {
        assert_eq!(slow_threshold_for_tier(1), 20_000);
        assert_eq!(slow_threshold_for_tier(5), 60_000);
        // Out-of-range tiers are clamped, never a fixed 30s.
        assert_eq!(slow_threshold_for_tier(0), 20_000);
        assert_eq!(slow_threshold_for_tier(99), 60_000);
    }
}
