//! Adaptive engine (milestone 3): SM-2 scheduling, composite mastery with
//! forgetting-curve decay, decay-adjusted prerequisite gating, and the session
//! builder. All scoring is server-authoritative; reads never write (#0c).

pub mod mastery_calc;
pub mod session;
pub mod sm2;
