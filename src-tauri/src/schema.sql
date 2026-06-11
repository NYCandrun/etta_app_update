-- Etta database schema (Appendix B). Applied automatically on first launch,
-- idempotent (every statement uses IF NOT EXISTS). PRAGMAs that configure the
-- connection (journal_mode, foreign_keys, auto_vacuum) are set in Rust before
-- this script runs; they are repeated here for documentation parity with the
-- appendix but are harmless to re-issue.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE IF NOT EXISTS concepts (
    id                   TEXT PRIMARY KEY,
    domain               TEXT NOT NULL,
    module               TEXT NOT NULL,
    title                TEXT NOT NULL,
    prerequisites        TEXT NOT NULL DEFAULT '[]',   -- JSON array of concept IDs
    learning_objectives  TEXT NOT NULL DEFAULT '[]',   -- JSON array (MUST be loaded + sent to AI)
    difficulty_tier      INTEGER,                       -- 1-5 (MUST be loaded + sent to AI)
    error_patterns       TEXT NOT NULL DEFAULT '[]',    -- JSON array of snake_case (MUST be loaded + sent to AI)
    mastery_score        REAL NOT NULL DEFAULT 0.0 CHECK(mastery_score >= 0.0 AND mastery_score <= 1.0),
    ease_factor          REAL NOT NULL DEFAULT 2.5 CHECK(ease_factor >= 1.3 AND ease_factor <= 3.5),
    interval_days        INTEGER NOT NULL DEFAULT 1 CHECK(interval_days >= 1 AND interval_days <= 180),
    next_review          TEXT,                          -- ISO 8601 date
    last_correct         TEXT,
    last_latency_ms      INTEGER CHECK(last_latency_ms IS NULL OR last_latency_ms >= 0),
    attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    streak_correct       INTEGER NOT NULL DEFAULT 0 CHECK(streak_correct >= 0)
);

CREATE TABLE IF NOT EXISTS quiz_answers (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id            TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    question_id           TEXT NOT NULL,                 -- "q1".."q10"
    question_type         TEXT NOT NULL CHECK(question_type IN ('multiple_choice','fill_in_blank','free_response')),
    prompt                TEXT NOT NULL,
    user_answer           TEXT,
    is_correct            INTEGER NOT NULL DEFAULT 0,    -- 0/1, computed SERVER-side
    score                 REAL,                          -- 0.0-1.0 for partial credit
    is_transfer           INTEGER NOT NULL DEFAULT 0,    -- feeds the 25% transfer term
    error_pattern_detected TEXT,
    latency_ms            INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
    created_at            TEXT NOT NULL
);

-- Reserved for future projects feature; created empty in slim v1.
CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id      TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    project_id      TEXT,
    file_basename   TEXT,                                -- basename ONLY
    mime_type       TEXT,
    feedback_json   TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','rejected')),
    submitted_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,                              -- allowlisted user-facing keys only
    value TEXT NOT NULL                                  -- typed accessors parse this
);

CREATE TABLE IF NOT EXISTS content_cache (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id      TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    content_type    TEXT NOT NULL CHECK(content_type IN ('lesson','quiz','explain','review')),
    payload_json    TEXT NOT NULL,                       -- CLEAN JSON only; NEVER append metadata
    mastery_band    TEXT,                                -- 'low'|'mid'|'high' side-band
    model_version   TEXT,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS xp_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    amount      INTEGER NOT NULL CHECK(amount >= 0 AND amount <= 100),
    source      TEXT NOT NULL,                           -- MUST be stored
    description TEXT NOT NULL DEFAULT '',                -- MUST be stored
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mastery_snapshots (
    date   TEXT NOT NULL,
    domain TEXT NOT NULL,
    score  REAL NOT NULL DEFAULT 0.0 CHECK(score >= 0.0 AND score <= 1.0),
    PRIMARY KEY (date, domain)
);

CREATE TABLE IF NOT EXISTS session_minutes (
    date    TEXT PRIMARY KEY,    -- YYYY-MM-DD
    minutes INTEGER NOT NULL DEFAULT 0 CHECK(minutes >= 0)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_concepts_next_review   ON concepts(next_review);
CREATE INDEX IF NOT EXISTS idx_concepts_domain        ON concepts(domain);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_concept   ON quiz_answers(concept_id);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_transfer  ON quiz_answers(concept_id, is_transfer);
CREATE INDEX IF NOT EXISTS idx_cache_concept_type     ON content_cache(concept_id, content_type);
CREATE INDEX IF NOT EXISTS idx_xp_events_created      ON xp_events(created_at);
CREATE INDEX IF NOT EXISTS idx_mastery_snapshots_date ON mastery_snapshots(date);
