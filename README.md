# Etta

An adaptive, gamified, offline-first learning app that takes an adult learner
from foundational algebra to university-level astrophysics. Native macOS
desktop app built with **Tauri 2.x**, **React 19 + TypeScript + Tailwind CSS**
(Vite) on the frontend, and **Rust** on the backend.

All content is generated on demand by a frontier LLM (Anthropic Claude); all
state is stored locally in SQLite. There is **no backend server, no accounts,
and no cloud sync**. The app uses the system WebKit (not bundled Chromium), so
the installed footprint targets < 20 MB.

> **Milestone 1 — foundation + data layer.** Builds on the M0 scaffold (shared
> FE/BE type contract, design system, security config, CI gates) by adding the
> full SQLite data layer: idempotent schema, typed settings, keychain API-key
> storage, the simplified content cache, bounded/pruned queries, input
> validation, structured logging, and a daily DB backup. The only feature
> screen is a bare Settings form; other screens remain placeholders.

---

## Routes

Routing uses **`HashRouter`** (never `BrowserRouter` — history routing breaks
under Tauri's `tauri://` file protocol). Defined in `src/App.tsx`:

| Path                   | Page                | Notes                              |
| ---------------------- | ------------------- | ---------------------------------- |
| `/onboarding`          | `OnboardingPage`    | Standalone (no app chrome)         |
| `/dashboard`           | `DashboardPage`     | App launches here (`*` redirects)  |
| `/lesson/:conceptId`   | `LessonPage`        | Reads `conceptId` param            |
| `/quiz/:conceptId`     | `QuizPage`          | Reads `conceptId` param            |
| `/progress`            | `ProgressPage`      |                                    |
| `/settings`            | `SettingsPage`      | Bare form: API key, theme, goal    |

(The `projects` feature is deferred to v1.1+, so there is no `/project`
route in slim v1.)

Unknown paths redirect to `/dashboard`.

## Stores (Zustand)

Stores are the **single source of truth**; no component keeps a duplicated or
derived copy of store state that can drift. Located in `src/stores/`:

- **`useSettingsStore`** — `AppSettings` mirror (backend/SQLite is authoritative
  on disk). Owns the theme preference and applies it on change.
- **`useGamificationStore`** — `GamificationState` snapshot. XP/level/streak are
  computed and persisted server-side; this only mirrors the synced value.
- **`useSessionStore`** — the active `DailySession` (interleaved queue + active
  concept) for the current session.
- **`useCurriculumStore`** — the concept graph keyed by id (`Record<id, Concept>`),
  one record per concept. Gating reads `effectiveMastery`.

## Shared FE/BE type contract

The single source of truth for IPC lives in two mirrored files (Appendix C):

- **TypeScript:** `src/types/contract.ts`
- **Rust:** `src-tauri/src/contract.rs` — every struct derives
  `Serialize, Deserialize` with `#[serde(rename_all = "camelCase")]`.

The IPC envelope `IpcResult<T>` is `{ ok: true, data: T } | { ok: false, error:
string }` (a real JSON boolean discriminant). Rust commands return
`Result<T, String>`, mapped into this envelope so the frontend always handles an
explicit ok/error branch (errors are never silently swallowed — toast + retry).

### Round-trip test

`cargo test` serializes one sample of every contract type to
`src/types/__generated__/contract-fixture.json` (via the
`writes_contract_fixture` test). The Vitest test
`src/types/contract.roundtrip.test.ts` then asserts that the camelCase JSON
shape matches the TypeScript interfaces. If the two sides ever diverge, the test
fails. **Run `cargo test` (or `make fixture`) before `vitest`** so the fixture
is fresh.

## Design system

Located in `src/components/ui/` (barrel: `src/components/ui/index.ts`):

- **`<Card>`** — the one shared card surface.
- **`<Button variant="primary | secondary | ghost | danger">`** — defaults to
  `type="button"`. Standardized labels live in `src/lib/labels.ts` (e.g. quiz
  submission is **always** "Check Answer").
- **`<Skeleton>`** — the single app-wide loading primitive; callers size it to
  match final content to prevent layout shift.
- **`<Spinner>`** — inline button/affordance busy state only.
- **`<InlineError>`** / **`<ErrorToast>` + `ToastProvider`/`useToast`** —
  accessible async-error surfaces with retry (never a native `alert()` or a
  silent blank screen). Color is never the only signal.

### Design tokens

Semantic colors (`primary`, `accent`, `success`, `warning`, `danger`,
`surface`, `text`) are defined for **both light and dark themes** as CSS
variables in `src/styles/theme.css` and exposed through `tailwind.config.js`.
All pairings are tuned for **WCAG AA** contrast. Components reference semantic
token names only — never off-palette `blue-*` utilities for semantic meaning.
Animation durations are tokens (`duration-fast/base/slow`).

### Theme

`light` / `dark` / `system`. For `system`, `src/lib/theme.ts` registers a
`matchMedia('(prefers-color-scheme: dark)')` `change` listener (wired in
`src/main.tsx`) so the UI reacts live to OS theme changes.

## Security configuration

`src-tauri/tauri.conf.json` + `src-tauri/capabilities/default.json`:

- **CSP:** `default-src 'self'`; `script-src 'self'`; `connect-src` limited to
  `'self' https://api.anthropic.com` (the only external host).
- **`withGlobalTauri: false`** — specific `@tauri-apps/api` modules are imported
  instead of relying on the global.
- **`macos-private-api` is not enabled** (the field is absent → default false).
- **Capabilities** grant only what is used: `dialog`, `fs` scoped to `$APPDATA`,
  and **no shell** permission.
- Keychain service id / bundle id is **`com.etta.app`** (no legacy name).

## Rust crate hygiene

`src-tauri/Cargo.toml`:

- `tokio` features are scoped to `["rt-multi-thread", "time", "macros"]` — **not
  `"full"`**.
- Includes `reqwest`, `rusqlite` (`bundled` for static SQLite), `serde`,
  `serde_json`, `keyring`, `sha2`, `tracing`, `tracing-subscriber`, `chrono`.
- **No `hmac` crate.** Slim v1 does not HMAC the content cache (the threat
  model — a user tampering with their own learning content — is self-defeating;
  see the cache section below).
- **No document-processing crates** (no pdf-parse / mammoth / sharp / OCR).
- The shared `xml_escape` util (`src-tauri/src/util.rs`, Appendix A.4) is the
  prompt-injection defense applied to every interpolated prompt field.

## Data layer (SQLite)

One connection is opened on first launch and held in Tauri app state behind a
`Mutex` (`AppState`, `src-tauri/src/db.rs`) — never a connection per command.
The connection runs with `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, and
`auto_vacuum = INCREMENTAL`. The schema (Appendix B, embedded from
`src-tauri/src/schema.sql`) is applied on every startup and is **idempotent**
(`CREATE TABLE IF NOT EXISTS` throughout; applying it twice is a no-op).

Tables: `concepts` (incl. `learning_objectives`, `difficulty_tier`,
`error_patterns`), `quiz_answers` (per-question history — new in slim v1),
`submissions` (reserved for the deferred projects feature; uses
`file_basename`, **not** a full path), `settings`, `content_cache`,
`xp_events`, `mastery_snapshots`, `session_minutes`.

- **Typed settings** (`src-tauri/src/settings.rs`): `daily_goal_minutes` is an
  `i64`, `theme` is validated against `light|dark|system`, etc. — never the
  "everything is a string" coercion bug. `set_setting` enforces a hard
  **allowlist** of user-facing keys and rejects unknown ones.
- **API key** (`src-tauri/src/keychain.rs`): stored **only** in the OS keychain
  via the `keyring` crate, service id `com.etta.app`. Never written to SQLite,
  a file, or obfuscated. The DB persists only the `api_key_present` flag.
  `test_api_key` reads the **stored** key — it takes no key parameter that could
  be logged.
- **Content cache** (`src-tauri/src/cache.rs`): payloads are stored as **clean
  JSON**; side-band `mastery_band` / `model_version` live in their own columns
  (never appended onto the JSON string). On read, a payload that fails
  `JSON.parse` is treated as a **miss** (logged), never as trusted content. No
  HMAC. Hygiene: 30-day TTL purge on startup, 7-day staleness skip on read, and
  at most the 3 most recent entries per `(concept_id, content_type)`.
- **Bounded queries & pruning** (`src-tauri/src/mastery.rs`): every query has a
  `LIMIT`. `xp_events` is pruned to ~1000 rows / 90 days; `mastery_snapshots`
  reads default to a 90-day window. `get_mastery_history` is a **pure read**
  (zero writes); snapshots are written only via the explicit
  `write_mastery_snapshot`.
- **Input validation** (`src-tauri/src/validate.rs`): every command checks
  lengths, numeric ranges, and concept-id format (`^[a-z]{2,4}_[0-9]{3}$`),
  rejecting bad input with a typed error.
- **Logging**: structured `tracing` to stderr for key/file/db operations and
  failures. The API key and other secrets are **never** logged; user-facing
  errors are generic.
- **Daily backup**: on startup, if the last backup is >24h old, the DB file is
  copied to a timestamped file in the app support directory.

### Typed settings keys (allowlist)

| Key                        | Type   | Allowed values / notes              |
| -------------------------- | ------ | ----------------------------------- |
| `daily_goal_minutes`       | i64    | one of 15 / 30 / 45 / 60            |
| `theme`                    | enum   | `light` \| `dark` \| `system`       |
| `base_model`               | string | e.g. `claude-sonnet-4-6`            |
| `reasoning_model`          | string | reserved/unused in slim v1          |
| `new_concepts_per_session` | i64    | 1–10                                |
| `notifications_enabled`    | bool   | `true` \| `false`                   |
| `api_key_present`          | bool   | flag only; key lives in keychain    |

Any key not on this list is rejected.

## AI layer (milestone 2)

The AI layer is the app's sole content engine (Anthropic Messages API). It lives
under `src-tauri/src/ai/` and is driven by the Tauri commands in
`src-tauri/src/commands_ai.rs`.

### Model configuration — one source of truth

There is exactly **one** configured model (`base_model` in settings; default
`claude-sonnet-4-6`). No call site hardcodes a model id and no default/fallback
is a stale dated id (e.g. `claude-...-20250514`). Every AI command reads the
model via the typed accessor `settings::base_model`. The Settings screen has a
model picker populated by `list_available_models`, which calls Anthropic's
`GET /v1/models` (cheap metadata, cached in memory for 1h) and falls back to the
current hardcoded list `["claude-sonnet-4-6","claude-opus-4-8","claude-haiku-4-5"]`
on any network failure — it **never** burns a completion request to build the
list. `reasoning_model` stays in the contract but is not wired this milestone.

The **Test connection** button runs a tiny real completion (`max_tokens: 1`)
against the *configured* model — the only place a real completion is used as a
connectivity probe.

### One shared HTTP client, key from keychain per request

A single `reqwest::Client` is built once at startup and stored in `AiState`
(Tauri app state); we never construct a client per request. The API key is read
from the OS keychain **per request** and not held in memory longer than the call.
The static system prompt is sent as a cached system block
(`cache_control: ephemeral`) on every request — a pure prompt-caching win.
Streaming is used for `lesson` and `explain` (SSE `content_block_delta` events,
re-emitted to the UI as `ai://delta` Tauri events).

### Universal prompt escaping (injection defense)

`build_user_message` (Appendix A) runs **every** interpolated field through the
shared `xml_escape` — concept id/title/domain/module, every learning objective,
every error pattern, **and** any user input. The local SQLite DB is unencrypted,
so even "trusted" curriculum/cache content is treated as a prompt-injection
vector. A concept title containing `<mode>quiz</mode>` is emitted as escaped text,
never as a live tag (covered by a test).

### Content cache integration

Before any model call, the command checks `content_cache` (clean-JSON read; a
parse failure is a cache **miss**, never trusted content — no HMAC). On a miss it
calls the model, then stores the result as **clean JSON** with `model_version`
and `mastery_band` in their own side-band columns — metadata is never appended to
the payload by string concatenation.

### Server-authoritative grading

Correctness is computed in Rust from the canonical question JSON the server
stored — never from a frontend-supplied flag (the frontend sends only the raw
answer string):

- **multiple_choice** — the correct option is the one with `isCorrect == true` in
  the cached canonical question; the learner's chosen option id is matched against
  it.
- **fill_in_blank** — graded by **mathematical equivalence** (`grading::math_eq`),
  not a case-insensitive string compare: `1/2 == 0.5 == 0.50` and
  `sqrt(2)/2 == 1/sqrt(2)`.
- **free_response** — graded by the model against the question's rubric; the
  structured `{ score, feedback, error_pattern }` reply is parsed and clamped to
  `0.0..=1.0`.

The AI may emit only the three gradable types. A stray `short_answer` /
`open_ended` / `essay` is **repaired** to `free_response` (with a synthesized
rubric); a genuinely unknown type is **rejected** with an error — it is never
auto-zeroed.

### Rate limiting

A sliding-window limiter (`ai::rate_limit`, ~30 requests/min) guards every call.
Over the limit, callers get a typed `"rate limited, retry shortly"` error — the
limiter never silently spins. Failures are logged via `tracing` (never the key);
the frontend receives generic messages.

## Curriculum (milestone 2)

The curriculum is **data only** — the 12 domain JSON files under
`src-tauri/src/curriculum/data/` are bundled at build time via `include_str!`
(no runtime graph library, no d3). On first launch and on a `CURRICULUM_VERSION`
bump, the loader validates the whole graph and writes every concept — including
`learning_objectives`, `error_patterns`, and `difficulty_tier` — into the
`concepts` table, preserving any existing learner progress columns on re-import.

### DAG validation (hard fail at startup)

Loading aborts (fatal) if any of these fail: a concept id does not match
`^[a-z]{2,4}_[0-9]{3}$`, a duplicate id exists, a prerequisite resolves to no
concept (including cross-domain), or the graph contains a cycle (Kahn
topological sort must order every node). A concept with empty
`learning_objectives`/`error_patterns` or a `difficulty_tier` outside `1..=5` is
also rejected.

### Domains, phases, and prerequisite edges

402 concepts across 12 domains. The graph is **not** a single linear chain:
after Single-Variable Calculus, Linear Algebra and Differential Equations
progress as **parallel tracks** (both anchor on Single-Variable Calculus), and
Quantum Mechanics anchors on Linear Algebra. Light **bridge** concepts smooth
jarring transitions (e.g. *Precalc Limits → Epsilon-Delta*; *Maxwell–Boltzmann*
and *error propagation* appear inline in thermo/astro since the Statistics &
Probability domain is deferred).

| Phase | Domain | Concepts | Prereq domain(s) |
| ----- | ------ | -------- | ---------------- |
| 1 | Algebra | 56 | — |
| 1 | Trigonometry | 28 | Algebra |
| 1 | Pre-Calculus | 25 | Trigonometry (← Algebra) |
| 2 | Single-Variable Calculus | 43 | Pre-Calculus |
| 2 | Multivariable Calculus | 33 | Single-Variable Calculus |
| 2 | Linear Algebra | 30 | Single-Variable Calculus *(parallel track)* |
| 2 | Differential Equations | 27 | Single-Variable Calculus *(parallel track)* |
| 3 | Classical Mechanics | 33 | Multivariable Calculus |
| 3 | Electromagnetism | 26 | Multivariable Calculus |
| 3 | Thermodynamics & Statistical Mechanics | 23 | Multivariable Calculus |
| 3 | Quantum Mechanics | 31 | Linear Algebra |
| 4 | Astrophysics | 47 | Classical Mechanics |

### `formatModuleLabel`

`src/lib/labels.ts` exposes `formatModuleLabel("alg_m01") === "Module 1"`. v1
rendered the label via `.slice(-1)`, which only worked by luck for single-digit
modules and broke at `_m10`/`_m12`; the util now parses the trailing number and
falls back to the raw id for an unrecognized shape.

## Learning loop & adaptive engine (milestone 3)

The lesson + quiz views, the adaptive scheduling engine, and minimal
gamification. The frontend renders and collects; the backend is the single
source of truth for grading, scheduling, mastery, and XP.

### Locked quiz schema

A quiz is a JSON array of question objects in EXACTLY three types — no others
are accepted (Appendix A.1/A.3). The AI is validated/repaired against this
shape before storage (a stray `short_answer` is coerced to `free_response`,
never auto-zeroed):

| type              | answer-bearing field | graded by                         |
| ----------------- | -------------------- | --------------------------------- |
| `multiple_choice` | `options[].isCorrect`| Rust: chosen id vs canonical id   |
| `fill_in_blank`   | `blanks[]`           | Rust: mathematical equivalence    |
| `free_response`   | `rubric`             | model call against the rubric     |

The TypeScript `Question`/`QuizOption` types mirror the Rust structs
(`#[serde(rename_all = "camelCase")]`); the contract round-trip test guards
against drift.

### Grading flow (server-authoritative — bug 0a)

1. The frontend sends only `{ questionId, answer }` per question — **never** an
   `isCorrect` flag.
2. `grade_quiz` loads the **canonical** questions from the content cache (the
   same clean JSON `generate_quiz` stored) and computes correctness in Rust.
   A forged `isCorrect` from the client is structurally impossible — the field
   does not exist on the submission type.
3. The final score on the completion screen is computed from a ref snapshot
   that **includes the last answer** (bug 0e): `answersRef` accumulates each
   answer synchronously before grading, so an N-question quiz grades N answers,
   not N−1.
4. `record_quiz_result` persists each graded answer to `quiz_answers`
   (`question_type`, `user_answer`, `is_correct`, `score`, `is_transfer`,
   `error_pattern_detected`, `latency_ms`), then advances the adaptive state in
   one attempt.

### Mastery formula (rolling window + live transfer)

Composite over the last `WINDOW = 20` attempts (`mastery_calc.rs`):

```
mastery = 0.50·accuracy + 0.25·consistency + 0.25·transfer
```

- **accuracy** — mean correctness over the window.
- **consistency** — `1 − variance/0.25` of the 0/1 correctness series.
- **transfer** — accuracy over `is_transfer = true` questions only. This term
  is **live**: `is_transfer` is read from the canonical questions and stored per
  answer (v1 hardcoded it false, killing 25% of the model). With no transfer
  attempts yet it falls back to overall accuracy so a learner is not penalized
  before seeing a transfer item.

### SM-2 parameters (Appendix E, exact)

`sm2.rs` implements the corrected SM-2:

| parameter            | value                                            |
| -------------------- | ------------------------------------------------ |
| starting ease        | 2.5                                              |
| Easy / Hard·Fail     | +0.1 / −0.2                                       |
| ease floor / **cap** | 1.3 / **3.5** (the cap v1 lacked)                |
| interval cap         | 180 days                                          |
| initial steps        | 1 day → 6 days, then × ease                       |
| force-review         | not reviewed in 60 days → re-queued               |
| re-entry             | mastery < 0.6 → back in the active queue          |
| slow threshold       | per-tier: 20s at tier 1, +10s/tier (not fixed 30s)|

Quality is classified from overall correctness, the running correct-streak
(≥3 → Easy), and the slowest answer's latency against the tier threshold.

### Decay model & prerequisite gating

Stored mastery erodes on an exponential forgetting curve keyed to ease:

```
effective_mastery = mastery · exp(−days_since_review / (k · ease_factor)),  k = 14
```

A dependent concept unlocks only when **every** prerequisite's
`effective_mastery ≥ 0.8` — the **decay-adjusted** value, never the raw stored
score (bug 7.3: a long-ago "mastered" prerequisite must not unlock dependents).

### Session-builder rules

`session.rs` builds the daily session as a pure read (never writes — bug 0c):

- **Multiple new concepts**, scaled by `new_concepts_per_session` and
  `daily_goal_minutes` (+1 per extra 15 min over the 15-min floor); v1 capped
  exactly one.
- **Total size capped** at 12 so a returning learner is not buried.
- Reviews prioritized by relationship to today's new domain, then by decay
  (lowest effective mastery first) — not merely "most overdue".
- The interleaving function is **actually called**, weaving new + review so the
  queue alternates (v1 defined it but never invoked it).

### XP / streak / daily-goal-ring contract

- **XP** is backend-only and single-source: every grant appends to `xp_events`
  (storing both `source` and `description`); the total is `SUM(amount)`. The
  frontend reads the synced value from the gamification store — **never**
  increments a local copy. Lesson and quiz XP each fire **exactly once**,
  guarded by a persisted per-concept `source` marker (`lesson:<id>` /
  `quiz:<id>`).
- **No level math.** `LevelInfo` is a fixed placeholder
  `{ level: 1, title: "Learner", xpIntoLevel: xp, xpForNextLevel: xp+1 }`,
  `badges: []` — keeping the contract stable while making the v1 overflow bug
  (0d) impossible by construction.
- **Streak** lives under one canonical key (`__streak_state`); a one-day gap
  continues it, a single missed day can be bridged by a freeze, a larger gap
  resets to 1.
- **Daily-goal ring** reads **real tracked minutes** from `session_minutes`
  (bug H1) — lesson/quiz screens record wall-clock time and flush whole minutes
  on unmount via `add_study_minutes`. The ring renders `minutesToday/goal`,
  never a hardcoded 40%/100%.
- The gamification snapshot is fetched **once** at launch by a single provider
  (`GamificationProvider`), not independently from each shell component.

### Shared math/RichText renderer (bugs 0f, 32, 42)

All learner-facing math goes through one renderer (`lib/math.ts` +
`components/RichText.tsx`): KaTeX with `output: "htmlAndMathml"` (real MathML
for screen readers), sanitized by DOMPurify before any
`dangerouslySetInnerHTML`. On a KaTeX failure it shows the literal
`"Math display error"` — never the raw LaTeX, and never raw LaTeX as an
aria-label.

## Data-at-rest security (FileVault)

The SQLite database is **not** encrypted at the application layer (no SQLCipher
in slim v1). Confidentiality of learning data at rest relies on macOS
**FileVault** full-disk encryption. The threat model deliberately excludes a
user tampering with their own local learning content — that is self-defeating —
so the content cache is not integrity-checked (no HMAC). If content ever
becomes shareable/exportable, re-introduce integrity verification at that point.

---

## Running the CI gates

A `Makefile` wraps every gate. `make ci` runs the backend gates first (which
generate the contract fixture), then the frontend gates.

```sh
# One-time setup
npm install
# Rust toolchain (stable) + Linux Tauri build deps:
#   libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# All gates
make ci

# Individual gates
npm run typecheck                                  # tsc --noEmit (strict)
npm run lint                                       # eslint
cargo test    --manifest-path src-tauri/Cargo.toml # Rust tests + fixture
cargo clippy  --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt     --manifest-path src-tauri/Cargo.toml --check
npm run test                                       # vitest (run cargo test first)

# Builds
npm run build                                      # tsc --noEmit && vite build
cargo build   --manifest-path src-tauri/Cargo.toml --bin etta
```

### Platform notes (macOS target on a Linux dev host)

The app targets **macOS (universal binary)**. The Rust/JS code compiles and
links on Linux against the system WebKitGTK, so all CI gates run on Linux. The
shippable artifacts are **macOS-only** and must be produced on macOS:

```sh
# On macOS, with Xcode CLT and rustup targets installed:
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

The library crate-type is `["lib"]` (desktop-only). If iOS/Android support is
later added, append `"staticlib"` / `"cdylib"` for those mobile targets.
