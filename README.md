# Etta

An adaptive, gamified, offline-first learning app that takes an adult learner
from foundational algebra to university-level astrophysics. Native macOS
desktop app built with **Tauri 2.x**, **React 19 + TypeScript + Tailwind CSS**
(Vite) on the frontend, and **Rust** on the backend.

All content is generated on demand by a frontier LLM (Anthropic Claude); all
state is stored locally in SQLite. There is **no backend server, no accounts,
and no cloud sync**. The app uses the system WebKit (not bundled Chromium), so
the installed footprint targets < 20 MB.

> **Status — slim v1, all milestones landed.** The M0 scaffold (shared FE/BE
> type contract, design system, security config, CI gates), the M1 SQLite data
> layer, the M2 AI + curriculum layer, the M3 learning loop + adaptive engine,
> M4 onboarding/placement/dashboard, and M5 polish/offline/shipping are all in
> place, hardened by a post-M5 refactor (merged server-side grading, Channel
> streaming, redacted wire contract, WAL-safe backups). The milestone labels on
> the sections below are kept as section markers, not as status.

---

## Routes

Routing uses **`HashRouter`** (never `BrowserRouter` — history routing breaks
under Tauri's `tauri://` file protocol). Defined in `src/App.tsx`:

| Path                   | Page                | Notes                              |
| ---------------------- | ------------------- | ---------------------------------- |
| `/onboarding`          | `OnboardingPage`    | Standalone (no app chrome); ungated |
| `/placement`           | `PlacementPage`     | 5-question micro-quiz; ungated      |
| `/dashboard`           | `DashboardPage`     | App launches here (`*` redirects)  |
| `/lesson/:conceptId`   | `LessonPage`        | Reads `conceptId` param            |
| `/quiz/:conceptId`     | `QuizPage`          | Reads `conceptId` param            |
| `/progress`            | `ProgressPage`      |                                    |
| `/settings`            | `SettingsPage`      | API key, model picker, theme, goal, data export |

(The `projects` feature is deferred to v1.1+, so there is no `/project`
route in slim v1.)

Unknown paths redirect to `/dashboard`.

**First-run gating** (`src/components/OnboardingGate.tsx`): the gate reads
`useOnboardingStore`, which hydrates exactly **once** at boot via
`get_onboarding_complete`; until onboarding **and** placement have finished
(the reserved `__onboarding_complete` flag), every non-onboarding route redirects
to `/onboarding`. `done` is **terminal** — nothing ever re-checks the backend, so
navigating around the app never re-fetches (and never re-flashes the gate
skeleton). A failed hydrate renders an error card with a **Retry** button, never
a blank screen. The gate lives inside the router (it reads the current path) and
deliberately leaves `/onboarding` and `/placement` ungated so the first-run flow
can run. The persisted flag is set server-side by `place_learner` /
`skip_placement`, never by the frontend; both placement completion paths (place
**and** skip) also call the store's `markComplete()` so the gate opens
immediately, without a relaunch.

## Stores (Zustand)

Stores are the **single source of truth**; no component keeps a duplicated or
derived copy of store state that can drift. Located in `src/stores/`:

- **`useSettingsStore`** — `AppSettings` mirror (backend/SQLite is authoritative
  on disk), hydrated once at the app root. Owns the theme preference and applies
  it on change.
- **`useGamificationStore`** — `GamificationState` snapshot. XP/level/streak are
  computed and persisted server-side; this only mirrors the synced value.
- **`useCurriculumStore`** — the concept graph keyed by id (`Record<id, Concept>`),
  one record per concept. Gating reads `effectiveMastery`.
- **`useOnboardingStore`** — the first-run flag. Hydrated exactly once at boot by
  the gate; `done` is terminal (see first-run gating above).
- **`useDailyProgressStore`** — single fetch owner for today's
  `minutesToday`/`goalMinutes`. The header ring and the dashboard ring read this
  one store (they can never drift apart); it refreshes after every study-minute
  flush and on dashboard remount, and surfaces an error at most once per
  failure streak.
- **`useLeaveGuardStore`** — the sidebar-navigation leave guard: an in-progress
  quiz registers a guard that `AppLayout` consults before following a nav link
  (the declarative `HashRouter` has no `useBlocker`).

There is deliberately **no session store**: session continuity is a fresh
`build_session` call — the quiz-completion screen's "Next up: *{title}*" CTA —
never a client-side copy of the queue that could drift from the backend.

## Shared FE/BE type contract

The single source of truth for IPC lives in two mirrored files (Appendix C):

- **TypeScript:** `src/types/contract.ts`
- **Rust:** `src-tauri/src/contract.rs` — every struct derives
  `Serialize, Deserialize` with `#[serde(rename_all = "camelCase")]`.

Rust commands return `Result<T, String>`; Tauri resolves the invoke promise on
`Ok` and rejects it on `Err`. There is **no Rust-side envelope type** — the
`call()` wrapper in `src/lib/ipc.ts` catches the rejection and synthesizes the
**client-side** envelope `IpcResult<T>` = `{ ok: true, data: T } | { ok: false,
error: string }` (a real JSON boolean discriminant, defined in `contract.ts`),
so the frontend always handles an explicit ok/error branch (errors are never
silently swallowed — toast + retry).

The canonical server-side `Question` — the one carrying the answer key (option
`isCorrect` flags, accepted `blanks`, the `rubric`) — is deliberately **not**
part of the contract: the webview only ever receives the redacted
`WireQuestion` / `WireQuizOption` (H10 — the answer key never ships
pre-grade). The other wire shapes: `AnswerSubmission`
`{ questionId, answer, latencyMs }` (latency folded into the answer struct,
never a separately-indexed array), `GradedAnswer` (including post-grade
`correctAnswer` + `feedback`), `QuizOutcome` (`recorded` / `retryToken` /
refreshed `gamification` snapshot), `PlacementResult`, `DailySession`,
`DailyProgress`, and `Concept` (including `lastAttemptAt`, the recency signal
the dashboard sorts by).

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
  `type="button"`. Standardized labels live in `src/lib/labels.ts`, and every
  entry there has a real consumer (dead entries are deleted). Quiz/placement
  advance actions read **"Next"** and, on the last question, **"Finish quiz"**
  / **"Finish placement"** — never "Check Answer": the button advances/submits
  and does not reveal per-question correctness.
- **`<Skeleton>`** — the single app-wide loading primitive; callers size it to
  match final content to prevent layout shift.
- **`<Spinner>`** — inline button/affordance busy state only.
- **`<InlineError>`** / **`<ErrorToast>` + `ToastProvider`/`useToast`** —
  accessible async-error surfaces with retry (never a native `alert()` or a
  silent blank screen). Color is never the only signal. Toasts auto-dismiss
  after 6 s (hover pauses the timer), and at most 3 stack at once.

### Design tokens

Semantic colors (`primary`, `accent`, `success`, `warning`, `danger`,
`surface`, `text`) are defined for **both light and dark themes** as CSS
variables in `src/styles/theme.css` and exposed through `tailwind.config.js`.
All pairings are tuned for **WCAG AA** contrast. Components reference semantic
token names only — never off-palette `blue-*` utilities for semantic meaning.
Animation durations are tokens (`duration-fast/base/slow`).

### Theme

`light` / `dark` / `system`. For `system`, `src/lib/theme.ts` registers a
`matchMedia('(prefers-color-scheme: dark)')` `change` listener so the UI reacts
live to OS theme changes. To kill the white flash before React hydrates, a
pre-hydration snippet in `index.html` reads a **boot-time cache** of the theme
from `localStorage` (`etta-theme`). Mirror discipline is strict: that key is
**written only** by `applyTheme()` and **read only** by the boot snippet — the
SQLite settings row remains the single source of truth, the mirror is never a
second one.

## Security configuration

`src-tauri/tauri.conf.json` + `src-tauri/capabilities/default.json`:

- **CSP:** `default-src 'self'`; `script-src 'self'`; `connect-src` limited to
  `'self' https://api.anthropic.com` (the only external host).
- **`withGlobalTauri: false`** — specific `@tauri-apps/api` modules are imported
  instead of relying on the global.
- **`macos-private-api` is not enabled** (the field is absent → default false).
- **Capabilities** grant only what is used: `dialog` (incl. save) and a single
  **write-only** `fs:allow-write-text-file` grant scoped to the standard export
  destinations (`$DOWNLOAD` / `$DOCUMENT` / `$DESKTOP`). The webview can read
  **nothing** through fs (no read/mkdir/exists commands at all), `$APPDATA`
  (etta.db, canonical answer keys) is outside the fs scope, and the export flow
  writes only to a dialog-chosen path. **No shell** permission.
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
  **allowlist** of user-facing keys and rejects unknown ones — and it also
  rejects `api_key_present`, which is **derived** state managed exclusively by
  `set_api_key` / `delete_api_key` (the key stays allowlisted for reads).
- **API key** (`src-tauri/src/keychain.rs`): stored **only** in the OS keychain
  via the `keyring` crate, service id `com.etta.app`. Never written to SQLite,
  a file, or obfuscated. The DB persists only the derived `api_key_present`
  flag, written **keychain-first**: `set_api_key` / `delete_api_key` update the
  keychain, then the flag, and roll the keychain back (best-effort, logged) if
  the flag write fails — so key material and flag never disagree.
  `test_connection` (the Settings **Test connection** button) reads the
  **stored** key — it takes no key parameter that could be logged.
- **Content cache** (`src-tauri/src/cache.rs`): payloads are stored as **clean
  JSON**; side-band `mastery_band` / `model_version` live in their own columns
  (never appended onto the JSON string). On read, a payload that fails
  `JSON.parse` is treated as a **miss** (logged), never as trusted content —
  and the corrupt row is **deleted** in the same read (it can never become
  valid), unmasking the next-newest valid row instead of letting one bad row
  hide it until the TTL purge. No HMAC. Two read paths: **serving**
  (`cache::get_for`) requires the entry's `mastery_band` + `model_version` to
  match the learner's current ones — a band crossing or model switch is a miss
  that regenerates instead of pinning stale content; **grading**
  (`cache::get_any`) loads the newest valid quiz regardless of staleness or
  band/model drift — the grader must see the exact quiz the learner was
  served. After a quiz is successfully recorded, its cache entry is
  **consumed** (deleted): the review screen revealed the answer key, so a
  retake regenerates rather than replays. Hygiene: 30-day TTL purge on
  startup, 7-day staleness skip on serving reads (grading is bounded only by
  the TTL), and at most the 3 most recent entries per
  `(concept_id, content_type)`.
- **Bounded queries, structurally bounded ledger**
  (`src-tauri/src/gamification.rs`): every query has a `LIMIT` (the recent-XP
  read returns the last 20 events). There is **no XP pruning job** — the
  ledger is structurally bounded because XP is granted at most twice per
  concept, guarded by the exactly-once `lesson:<id>` / `quiz:<id>` source
  markers (see the XP contract below). `mastery_snapshots` remains in the
  schema and the data export, but nothing writes it in slim v1 (reserved for
  learning-path history).
- **Input validation** (`src-tauri/src/validate.rs`): every command checks
  lengths, numeric ranges, and concept-id format (`^[a-z]{2,4}_[0-9]{3}$`),
  rejecting bad input with a typed error.
- **Logging**: structured `tracing` to stderr for key/file/db operations and
  failures. The API key and other secrets are **never** logged; user-facing
  errors are generic.
- **Daily backup**: on startup, if the newest backup — dated by its
  **filename** timestamp (`etta-backup-<stamp>.db`), never by mtime — is >24h
  old, the DB is snapshotted via **`VACUUM INTO`** into the app support
  directory. A plain file copy would silently drop every write still sitting
  in the WAL; `VACUUM INTO` snapshots through the live connection. The 7
  newest backups are kept, older ones pruned. Best-effort: a backup failure is
  logged but never blocks startup.

### Typed settings keys (allowlist)

| Key                        | Type   | Allowed values / notes              |
| -------------------------- | ------ | ----------------------------------- |
| `daily_goal_minutes`       | i64    | one of 15 / 30 / 45 / 60            |
| `theme`                    | enum   | `light` \| `dark` \| `system`       |
| `base_model`               | string | e.g. `claude-sonnet-4-6`            |
| `reasoning_model`          | string | reserved/unused in slim v1          |
| `new_concepts_per_session` | i64    | 1–10                                |
| `notifications_enabled`    | bool   | `true` \| `false`                   |
| `api_key_present`          | bool   | derived flag; key lives in keychain |

Any key not on this list is rejected. `api_key_present` is readable but
**cannot** be set through the generic `set_setting` surface — it is derived
from the keychain and written only by `set_api_key` / `delete_api_key`.

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

Timeouts are **idle-based, not total**: the shared client sets a 10 s connect
timeout and a 60 s idle **read** timeout — what bounds a *stalled* stream; an
active stream can run as long as generation takes. There is deliberately no
blanket total deadline (one used to abort healthy near-8192-token streams
mid-generation). Non-streaming calls (quiz generation, free-response grading)
add their own **300 s per-request total** on top. A transient failure — 429 or
any 5xx (incl. 529 overloaded) — is retried **exactly once** after a 1.5 s
pause; auth/client errors (401/403/4xx) are never retried, and a stream is
retried only **before its first byte** — once deltas have reached the UI, a
failure is never silently re-generated.

### Streaming: per-invocation Channel + cancellation

Streaming is used for `lesson` and `explain`: SSE `content_block_delta` events
are forwarded to the UI through a **per-invocation `tauri::ipc::Channel`** —
never a global window event — so chunks can never leak into another stream's
UI. The frontend generates a `requestId` per stream; `cancel_stream(requestId)`
flips a flag the streaming loop checks between chunks (`LessonPage` cancels on
unmount, and starting a new stream for the same window cancels the previous
one — a cancelled stream settles with the stable `EttaError:cancelled` marker,
which the UI treats as "stopped", not "failed"). Cache replays are sent through
the same Channel before returning, so the render path is identical either way.
A stream that ends without a clean `stop_reason` — or any response that hits
`max_tokens` (8192) — is an **error**: truncated output is never returned as
success and never cached (H20). SSE bytes are buffered across chunks, so
multi-byte UTF-8 never splits.

### Universal prompt escaping (injection defense)

`build_user_message` (Appendix A) runs **every** interpolated field through the
shared `xml_escape` — concept id/title/domain/module, every learning objective,
every error pattern, **and** any user input. The local SQLite DB is unencrypted,
so even "trusted" curriculum/cache content is treated as a prompt-injection
vector. A concept title containing `<mode>quiz</mode>` is emitted as escaped text,
never as a live tag (covered by a test).

### Content cache integration

Before any model call, the command checks `content_cache` through the
**serving** read (`cache::get_for`): a hit must have been generated for the
learner's **current** mastery band and configured model — a band crossing or
model switch regenerates instead of replaying (a parse failure is still a
cache **miss**, never trusted content — no HMAC). On a miss it calls the
model, then stores the result as **clean JSON** with `model_version` and
`mastery_band` in their own side-band columns — metadata is never appended to
the payload by string concatenation.

Lesson caching is keyed by the learner's **real mistakes**: when recent
`quiz_answers.error_pattern_detected` rows exist for the concept (fetched
server-side — the frontend sends no error-pattern input for lessons), the
prompt gains a reinforcement block and the result is cached under the distinct
**`lesson_reinforced`** content type; otherwise the plain lesson is cached
under `lesson`, so plain lessons stay cacheable and replayable offline.
Detected error patterns are grader-emitted model output, so they are
**sanitized twice** — markup carriers stripped and length capped at the parse
boundary before storage, and again when embedded into the reinforcement block
(covering rows persisted before sanitize-at-store existed) — on top of the
universal `xml_escape`. `explain` is conversational and never cached. Nothing
truncated, cancelled, or empty is ever cached, and a quiz that parses to fewer
than **3** questions is rejected outright (H21) — only validated output
reaches the cache.

### Server-authoritative grading

Correctness is computed in Rust from the canonical question JSON the server
stored — never from a frontend-supplied flag (the frontend sends only
`{ questionId, answer, latencyMs }`; see the grading flow in the learning-loop
section for the merged `grade_and_record_quiz` command):

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

### Error-string policy

Internal failures (rusqlite, serde, IO) are mapped at the command edge by
`util::internal_error` — the detail goes to `tracing` only; the frontend
receives a short, friendly "could not …" message. Two stable, machine-checkable
markers exist on top of that: **`EttaError:api_key`** (an Anthropic 401/403 —
the UI detects it via `isApiKeyError` and renders a "Fix API key" hint linking
to Settings) and **`EttaError:cancelled`** (learner-initiated stream
cancellation — never surfaced as a failure).

## Curriculum (milestone 2)

The curriculum is **data only** — the 12 domain JSON files under
`src-tauri/src/curriculum/data/` are bundled at build time via `include_str!`
(no runtime graph library, no d3). On first launch and on a `CURRICULUM_VERSION`
bump (currently **2**), the loader validates the whole graph and writes every
concept — including
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

402 concepts across 12 domains, with difficulty tiers spread across the full
1–5 range. The graph is **not** a single linear chain: after Single-Variable
Calculus, Multivariable Calculus, Linear Algebra and Differential Equations
progress as **parallel tracks** (all three anchor on Single-Variable Calculus),
and Quantum Mechanics anchors on Linear Algebra. Every cross-domain edge
anchors on the prerequisite domain's **last concept — its capstone** (e.g.
`trig_001 → alg_056`, `qm_001 → lin_030`, `astr_001 → cm_033`), so a domain
unlocks only once its prerequisite domain is genuinely finished; transitive
prerequisite closures are correspondingly deep (astrophysics' first concept
has **218** transitive prerequisites). Light **bridge** concepts smooth jarring
transitions (e.g. *Precalc Limits → Epsilon-Delta*; *Maxwell–Boltzmann* appears
inline in thermo and *error propagation* in multivariable calculus since the
Statistics & Probability domain is deferred).

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
never auto-zeroed), and a quiz with fewer than **3** questions is rejected
outright and never cached (H21):

| type              | answer-bearing field | graded by                         |
| ----------------- | -------------------- | --------------------------------- |
| `multiple_choice` | `options[].isCorrect`| Rust: chosen id vs canonical id   |
| `fill_in_blank`   | `blanks[]`           | Rust: mathematical equivalence    |
| `free_response`   | `rubric`             | model call against the rubric     |

The answer-bearing fields above exist only on the **canonical, server-side**
questions; the wire carries the redacted `WireQuestion`/`WireQuizOption`
(H10). Those TypeScript types mirror the Rust wire structs
(`#[serde(rename_all = "camelCase")]`); the contract round-trip test guards
against drift.

Parsing tolerates a markdown code fence around the JSON array (models drift
into fencing), and question ids are handled in two tiers: the **generation**
paths deterministically re-number fresh model output `q1..qN` before caching
(`parse_and_renumber` — duplicate or odd model-emitted ids are normalized, so
cache/wire/grading always agree and the exact-permutation gate stays
satisfiable), while every **other** consumer (cache re-validation, grading)
parses strictly and **rejects** duplicate ids outright.

### Grading flow (server-authoritative — bug 0a)

1. The frontend sends only `{ questionId, answer, latencyMs }` per question
   (`AnswerSubmission`) — **never** an `isCorrect` flag.
2. **`grade_and_record_quiz`** — grading and persisting fused in one command —
   first enforces that the submission is an **exact permutation** of the
   canonical question ids (no duplicates, omissions, or unknowns), then loads
   the **canonical** questions from the content cache via the grading read
   (`cache::get_any` — the newest stored quiz regardless of the 7-day serving
   window or band/model drift mid-quiz, so a just-answered quiz is never
   stranded ungradable; the same clean JSON `generate_quiz` stored) and
   computes correctness in Rust; `free_response`
   answers are graded **concurrently** (the UI shows a staged "Checking your
   written answers…" label while they run). A forged `isCorrect` from the
   client is structurally impossible — the field does not exist on the
   submission type, and graded answers never round-trip through the webview.
3. The final score on the completion screen is computed from a ref snapshot
   that **includes the last answer** (bug 0e): `answersRef` accumulates each
   answer synchronously before grading, so an N-question quiz grades N answers,
   not N−1 — and the score denominator is always the **canonical** question
   count, so omission could never inflate it.
4. The same command persists each graded answer to `quiz_answers`
   (`question_type`, `user_answer`, `is_correct`, `score`, `is_transfer`,
   `error_pattern_detected`, `latency_ms`) and advances the adaptive state in
   one transaction. If grading succeeded but persisting failed, the graded
   payload is still returned with `recorded: false` plus a `retryToken`: the
   UI shows the score anyway, and `retry_persist(token)` re-persists the
   **server-held** graded result without re-grading (free-response model calls
   are never re-bought). A successful record also **consumes** the cached quiz
   entry, so a retake regenerates instead of replaying the revealed answer
   key.
5. Post-grade, each `GradedAnswer` carries `correctAnswer` and `feedback` —
   populated server-side at grade time, safe to reveal **after** grading — and
   the completion screen's review renders them (option label text, never raw
   ids; correctness in text, not color alone). A recorded outcome also carries
   the refreshed gamification snapshot, and a fresh `build_session` call drives
   the "**Next up: *{title}***" CTA.

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

The decay clock keys to the most recent review **activity** — the later of
`last_correct` and the latest quiz attempt — so a concept the learner keeps
getting wrong still decays from its last attempt rather than never starting
its clock. Placement-**seeded**, never-attempted concepts (H16) do not decay
at all: the seed is a gate-opener, not a memory; the forgetting curve applies
only once the concept has a real attempt (`attempt_count > 0`).

### Session-builder rules

`session.rs` builds the daily session as a pure read (never writes — bug 0c):

- **Multiple new concepts**, scaled by `new_concepts_per_session` and
  `daily_goal_minutes` (+1 per extra 15 min over the 15-min floor); v1 capped
  exactly one.
- **Total size capped by the daily goal**: the queue holds
  `clamp(dailyGoalMinutes / 8, 3, 12)` concepts (~8 min per concept) — a
  15-minute goal still gets a meaningful session; a long goal stays bounded at
  12 so a returning learner is not buried.
- New-concept candidates are ordered **frontier-first** (H19): concepts from
  the highest-phase domain the learner has already touched come first, then
  phase order, then id — new work continues where the learner actually is.
- Reviews prioritized by relationship to today's new domain, then by decay
  (lowest effective mastery first) — not merely "most overdue". Only genuinely
  attempted concepts are reviewable (placement seeds stay out of both queues
  until first attempted).
- The interleaving function is **actually called**, weaving new + review so the
  queue alternates (v1 defined it but never invoked it).
- The empty-session fallback (nothing new, nothing due) uses the same
  frontier-first ordering and **never presents an already-completed concept as
  new**.

### XP / streak / daily-goal-ring contract

- **XP** is backend-only and single-source: every grant appends to `xp_events`
  (storing both `source` and `description`); the total is `SUM(amount)`. The
  frontend reads the synced value from the gamification store — **never**
  increments a local copy. Lesson and quiz XP each fire **exactly once**,
  guarded by a persisted per-concept `source` marker (`lesson:<id>` /
  `quiz:<id>`) — which also structurally bounds the ledger, so there is no
  pruning job.
- **No level math.** `LevelInfo` is a fixed placeholder
  `{ level: 1, title: "Learner", xpIntoLevel: xp, xpForNextLevel: xp+1 }`,
  `badges: []` — keeping the contract stable while making the v1 overflow bug
  (0d) impossible by construction.
- **Streak** lives under one canonical key (`__streak_state`) and advances on
  **any real activity** — a recorded quiz, a lesson XP award, or a nonzero
  study-minute flush — at most once per day (`touch_streak` is idempotent
  within a day, no matter how many sources fire). A one-day gap
  continues it, a larger gap resets to 1, and a **negative** gap (system clock
  rollback) neither resets the streak nor rewinds `last_active_date`. Freeze
  *bridging* logic exists, but slim v1 **never grants a freeze**
  (`freezesAvailable` stays 0) — no user-facing copy promises streak freezes.
- **Daily-goal ring** reads **real tracked minutes** from `session_minutes`
  (bug H1). `useStudyTimer` accumulates visible-time seconds and flushes whole
  minutes via `add_study_minutes` every 60 s while mounted, on
  `visibilitychange`/`pagehide` (webview-reliable "maybe quitting" signals,
  where a remainder ≥ 30 s rounds up to a minute — there may be no later
  chance), and on unmount; the sub-minute remainder carries across flushes and
  screens. Hidden-tab time is **never** counted: going hidden flushes and
  stops the clock, returning visible restarts it at "now", and a wake-up tick
  spanning the hidden window accrues nothing. A **failed** flush re-credits
  its minutes into the carry (bounded) so the next flush retries them instead
  of silently under-counting. Residual loss is bounded and documented honestly: quitting costs
  < 60 s of credit (< 30 s after a pagehide flush). Each successful flush
  refreshes the shared daily-progress store, and the ring renders
  `minutesToday/goal`, never a hardcoded 40%/100%.
- The gamification snapshot is fetched **once** at launch by a single provider
  (`GamificationProvider`), not independently from each shell component; the
  merged quiz command returns a refreshed snapshot on record, which the
  provider syncs into the store.

### Shared math/RichText renderer (bugs 0f, 32, 42)

All learner-facing math goes through one renderer (`lib/math.ts` +
`components/RichText.tsx`): KaTeX with `output: "htmlAndMathml"` (real MathML
for screen readers), sanitized by DOMPurify before any
`dangerouslySetInnerHTML`. On a KaTeX failure it shows the literal
`"Math display error"` — never the raw LaTeX, and never raw LaTeX as an
aria-label. The `$...$` tokenizer refuses to treat currency as math: a `$`
followed by whitespace, or with no same-line non-space-adjacent closer, stays
literal text (`"$5 and $10"` renders as-is).

RichText also renders lesson/explain prose through a hand-rolled **minimal
markdown subset** (`components/markdown.ts`): `##`/`###` headings, `- ` lists,
fenced code, `**bold**`, `*italic*`, `` `code` `` — emitted as **React
elements, never HTML strings**, so the security invariant holds: the *only*
injected HTML in the app remains DOMPurify-sanitized KaTeX output. Math spans
are tokenized first as opaque atoms, so markdown markers can wrap *around*
`$...$` but can never split a formula; and because lessons stream in chunks,
**any prefix of a valid document parses without throwing** — unterminated
`**`/`` ` `` markers degrade to literal text instead of erroring mid-stream.

## Onboarding, placement & dashboard (milestone 4)

### First-run flow

`Onboarding → 5-question placement micro-quiz → placed → dashboard → start
session → lesson/quiz`. The `OnboardingPage` collects a learning goal (the
curriculum always runs algebra→astrophysics, but the choice is not decorative —
each goal maps to a sensible suggested daily-time goal), the **daily-time
goal** (15/30/45/60 min, persisted as the typed `daily_goal_minutes` integer
that drives the session builder), the Anthropic API key (saved to the OS
keychain with inline, accessible format validation — never a native `alert()`;
if a key is already stored, a one-click **Use existing key** path skips the
re-paste), and the theme. It does **not** mark onboarding complete; that only
happens once placement succeeds.

### Placement algorithm

The placement micro-quiz is **5 questions, not a full diagnostic**. The backend
(`commands_placement.rs`) samples five early-phase concepts — three algebra
(tiers 1→3), one light precalculus, one light trig — and reuses the **same** quiz
prompt + locked schema as `generate_quiz`. Each concept yields one question,
re-id'd `q1..q5`; the five generations run **concurrently** (`join_all`, the
same pattern as free-response grading), so first-run latency is one model
round-trip, not five in a row. The canonical question JSON (with each item's source domain) is
stored **server-side** under the reserved `__placement_quiz` settings key; the
returned questions carry no correctness signal the frontend could forge.

Grading is **server-authoritative**: the frontend submits only
`{questionId, answer, latencyMs}` (never `isCorrect`), and the submission must
be an **exact permutation** of the five canonical question ids — duplicates,
omissions, and unknown ids are rejected (H9), and `PlacementResult.total` is
always the canonical count, so omission can never inflate a score. Objective
questions are graded deterministically; any free-response is graded by the
model against its rubric (the same shared grading path as the quiz command).
The correct-count maps to a starting concept:

| Correct out of 5 | Placement target            |
| ---------------- | --------------------------- |
| `< 2`            | foundational algebra (`alg_001`) |
| `2`–`3`          | intermediate algebra (`alg_017`) |
| `>= 4`           | precalculus (`prec_001`)    |

The chosen target's **transitive prerequisites** are seeded to a mastered state
(so its gate opens), and a modest starting `mastery_score` is seeded
(`0.0 / 0.3 / 0.5` by level) — never high enough to skip the concept, just enough
to start the learner warm. Seeded rows are recorded in the reserved
**`__placement_seeded`** set and get `next_review` pushed **60 days out**
(never left NULL/due); they are **exempt from decay and from the new/review
queues** until first genuinely attempted (H16 — a seed is not a memory to
decay), and they present as **Completed** in the concept map. Real history on
already-attempted rows is preserved, and the target keeps `attempt_count = 0`
so it still presents as fresh work. The adaptive engine corrects any
mis-placement within a few quizzes, which is why 5 questions is deliberately
enough. `place_learner` runs grading + seeding + the flag write in **one
transaction**: it sets `__onboarding_complete` and deletes the consumed
one-shot `__placement_quiz`. Every
prompt renders through the shared KaTeX/DOMPurify `RichText` surface (never literal
`$...$` text — carry-forward bug 0f; covered by `PlacementPage.test.tsx`).

**Skip path:** "Skip — let me choose where to start" calls `skip_placement`,
which seeds only the foundational base (cold start, mastery 0.0) and marks
onboarding complete, then drops the learner onto the static curriculum diagram to
tap any **unlocked** concept.

### Static curriculum diagram (build-time SVG, #49)

The curriculum map is a **single static SVG generated at build time** from the
12 domain JSONs — there is **no d3, no runtime graph layout, and no pan/zoom**.
`scripts/gen_curriculum_svg.mjs` lays phases out as columns, domains as cards, and
concepts as a node grid, draws aggregated domain-level prerequisite edges, and
emits two assets into `src/assets/`:

- `curriculum-map.svg` — the fixed diagram (with `<title>`/`<desc>` alt text
  describing all 12 phases/domains; decorative beyond that).
- `curriculum-map-positions.json` — `{ width, height, positions: { conceptId:
  {cx, cy} } }`.

The generator runs automatically via the `predev`/`prebuild` npm hooks (or
`npm run gen:svg`); the generated assets are **committed** so `tsc`, Vitest, and
import resolution never depend on generation order. `CurriculumDiagram.tsx`
injects the SVG (decorative, `aria-hidden`) and overlays a thin, React-driven
status layer positioned from the JSON: each concept dot is a real,
**keyboard-focusable `<button>`** with a ≥ 24 px hit target — the accessible
interactive surface. Only the dots' **status** is data-driven (read from
`useCurriculumStore`); the diagram geometry never changes at runtime.

### Concept list is the navigation surface

Learners do **not** start lessons from the diagram's nodes. The dashboard's
**Browse concepts** list (`ConceptList.tsx`) is the real navigation surface:
grouped by domain (in phase order), searchable, and keyboard-navigable. Each row
shows status as an **icon + text** (`Completed` / `In progress` / `Available` /
`Locked`), never color alone (#33); locked rows carry `aria-disabled` and expose
no action, while unlocked/in-progress/completed rows expose a **Start** button.
The dashboard's "Today's session" card is the M3 session builder (new + due
reviews, interleaved, with an estimate); its **Start Learning** CTA navigates
**exactly once** (H4 — it only navigates, with no second `onStart()` side-effect).
The daily-goal ring reflects **real tracked study minutes** from the DB (H1),
and the "**Continue where you left off:** *{title}*" CTA picks the most
recently attempted in-progress concept by the real recency signal
(`Concept.lastAttemptAt`), never a guess.

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

---

## Milestone 5 — polish, accessibility, offline & shipping

### Data export (#14, #40a)

Settings → **Your data** → **Export data** serializes every learner-produced row
into one JSON document via the `export_data` command (`src-tauri/src/export.rs`),
then opens a native save dialog defaulting to `etta-export-YYYY-MM-DD.json`.

The document contains: `concepts` (full progress: mastery, ease, interval, next
review, streaks), `quizAnswers` (graded history), `xpEvents` (the gamification
ledger — also the lesson/quiz attempt log), `masterySnapshots` (per-domain
learning-path history), `sessionMinutes` (tracked study time), and user-facing
`settings`.

Two hard guarantees, both covered by the inline test
`export_has_all_sections_and_no_secrets_or_paths`:

- **No secrets.** The API key lives only in the OS keychain and is never read
  here. The `settings` table holds only the `api_key_present` boolean. Reserved
  `__`-prefixed internal keys and any key whose name hints at a credential
  (`api_key`, `token`, `secret`, `password`, `credential`) are dropped.
- **No file paths (#40a, defensive).** Every exported free-text string runs
  through a path filter; anything path-shaped becomes `[redacted path]`.

**Delete API key** is an explicit button in Settings (calls `delete_api_key`,
which clears the keychain entry and the `api_key_present` flag).

### Accessibility & responsive (items #1–#13)

- ARIA roles on progress UI: the daily-goal ring is `role="progressbar"` with
  `aria-valuenow/min/max`; decorative icons are `aria-hidden`.
- Every input has a real `<label htmlFor>` (quiz, placement, API key, settings).
- Keyboard nav: skip link to `#main-content`, focusable `<main tabIndex={-1}>`,
  off-canvas sidebar with a hamburger (`aria-expanded` / `aria-controls`),
  Escape-to-close — and the drawer is `inert` while closed off-canvas, so Tab
  can never land on invisible nav links. Locked concepts use `aria-disabled` +
  text/icon (not color). The curriculum diagram's concept dots are real
  keyboard-focusable buttons (see above), not bare SVG circles.
- Math a11y: KaTeX renders to MathML for screen readers; raw LaTeX is never used
  as an `aria-label`; a render failure shows "Math display error".
- `aria-live="polite"` async status (see `OfflineNotice`); color is never the
  sole signal; WCAG AA contrast in both themes; `prefers-reduced-motion`
  honored (no infinite/global animations).
- Responsive: `px-4 md:px-8` padding, responsive dashboard grid, the static
  curriculum SVG scales (`width="100%" height="auto"`, `max-width` cap).

### True offline mode (#11)

`useOnline()` (`src/lib/useOnline.ts`) subscribes to the browser
`online`/`offline` events via `useSyncExternalStore`. When offline, every
AI-dependent action button (Start/Continue learning, "I don't get it", "Ready
for quiz", quiz/placement submit, Test connection) is **actually disabled**
(`disabled` + `aria-disabled`) — not merely warned about — and an accessible
`OfflineNotice` explains why. The one deliberate exception: concepts whose
lesson is already cached stay **startable offline**. A cheap `is_cached` probe
(`useCachedLessonIds`, no payload transfer) marks concepts with a cached
lesson (plain `lesson` or personalized `lesson_reinforced`), the backend
replays the cached stream through the Channel without any network, and the
dashboard CTAs and concept list consume the **same** probe result — showing an
identical "(available offline)" hint — so they can never disagree. When live
generation fails (offline, API failure, no key) and the **preferred** variant
isn't cached, the backend falls back to the **other** cached variant — plain
vs reinforced — before surfacing the error, through the same unfiltered read
the probe uses, so anything marked "available offline" is genuinely
replayable. The critical test asserts the buttons are disabled, not just that
a banner shows.

### Auto-updater (#16)

Configured in `tauri.conf.json` (`plugins.updater`) and registered in
`lib.rs` (`tauri_plugin_updater`, desktop only). Before the first signed
release you MUST generate a signing key pair and replace the placeholder:

```sh
# Generates a private key (keep secret!) and prints the public key.
npm run tauri signer generate -- -w ~/.tauri/etta.key
```

Then:

1. Put the **public** key into `tauri.conf.json` → `plugins.updater.pubkey`
   (currently `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`).
2. Host the update manifest + artifacts at the configured `endpoints`
   (`https://releases.etta.app/{{target}}/{{arch}}/{{current_version}}`).
3. Export the private key + password when building so artifacts are signed:
   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/etta.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<your password>"
   ```

`bundle.createUpdaterArtifacts` is `true`, so `tauri build` emits the
`.app.tar.gz` + `.sig` the updater consumes.

### Building the signed, notarized universal `.dmg` (macOS only)

These steps **cannot run on the Linux dev host** — they require macOS, Xcode
Command Line Tools, and a valid Apple Developer ID. Run on a Mac:

```sh
# 1. Toolchain
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 2. Signing identity (Developer ID Application) must be in the login keychain.
#    Find its name with:  security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# 3. Notarization credentials (App Store Connect API key OR Apple ID):
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"   # appleid.apple.com app pwd
export APPLE_TEAM_ID="TEAMID"

# 4. Updater signing key (see above)
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/etta.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<your password>"

# 5. Build, sign, and notarize the universal binary + .dmg in one shot.
#    Tauri runs codesign, submits to notarytool, and staples on success.
npm run tauri build -- --target universal-apple-darwin

# 6. Verify the staple on the produced artifacts:
xcrun stapler validate \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Etta_0.0.0_universal.dmg"
spctl -a -vvv -t install \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Etta.app"
```

The `.dmg` and `app` targets are set in `tauri.conf.json` →
`bundle.targets`; `macOS.minimumSystemVersion` is `11.0`.

### Performance targets (#16)

Verify on the release universal build on representative macOS hardware:

| Metric                         | Target    |
| ------------------------------ | --------- |
| Cold launch to interactive     | < 1.5 s   |
| Cached lesson render           | < 100 ms  |
| API lesson (streamed)          | < 8 s     |
| Quiz generation                | < 4 s     |
| SQLite query                   | < 10 ms   |
| Idle memory                    | < 100 MB  |
| Installed size                 | < 20 MB   |

### Daily DB backup

`db::backup_if_stale` runs at startup (`lib.rs` setup): if the newest
`etta-backup-<stamp>.db` (dated by its **filename** timestamp, never mtime) is
older than 24 h, it snapshots the live DB via **`VACUUM INTO`** — WAL-safe; a
plain file copy would miss un-checkpointed writes — and prunes down to the 7
newest backups. Confirm it works by launching, then checking for a fresh
`etta-backup-*.db` alongside the live DB in the per-OS app-data directory
(`~/Library/Application Support/com.etta.app/` on macOS).
