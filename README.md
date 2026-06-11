# Etta

An adaptive, gamified, offline-first learning app that takes an adult learner
from foundational algebra to university-level astrophysics. Native macOS
desktop app built with **Tauri 2.x**, **React 19 + TypeScript + Tailwind CSS**
(Vite) on the frontend, and **Rust** on the backend.

All content is generated on demand by a frontier LLM (Anthropic Claude); all
state is stored locally in SQLite. There is **no backend server, no accounts,
and no cloud sync**. The app uses the system WebKit (not bundled Chromium), so
the installed footprint targets < 20 MB.

> **Milestone 0 — foundation only.** This milestone ships the scaffold, the
> shared FE/BE type contract, the design system, security configuration, and
> the CI gates. Feature screens are empty placeholders until later milestones.

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
| `/project/:conceptId`  | `ProjectPage`       | Reads `conceptId` param            |
| `/progress`            | `ProgressPage`      |                                    |
| `/settings`            | `SettingsPage`      |                                    |

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
  `serde_json`, `keyring`, `hmac`, `sha2`, `tracing`, `chrono`.
- **No document-processing crates** (no pdf-parse / mammoth / sharp / OCR).
- The shared `xml_escape` util (`src-tauri/src/util.rs`, Appendix A.4) is the
  prompt-injection defense applied to every interpolated prompt field.

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
