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
