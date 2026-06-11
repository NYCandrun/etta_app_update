# Etta CI gates. Run `make ci` to execute every gate that works on this host.
# macOS-only steps (full `cargo tauri build` producing a universal binary)
# are documented in the README and are NOT part of these Linux-runnable gates.

.PHONY: ci ci-fe ci-be typecheck lint test fixture fmt-check clippy cargo-test fe-build

# Full CI: backend first (generates the contract fixture), then frontend.
ci: ci-be ci-fe

# ---- Frontend gates ----
ci-fe: typecheck lint test

typecheck:
	npm run typecheck

lint:
	npm run lint

test: fixture
	npm run test

fe-build:
	npm run build

# ---- Backend gates ----
ci-be: fmt-check clippy cargo-test

fmt-check:
	cd src-tauri && cargo fmt --check

clippy:
	cd src-tauri && cargo clippy --all-targets -- -D warnings

cargo-test:
	cd src-tauri && cargo test

# Generate the FE/BE contract fixture consumed by the TS round-trip test.
fixture:
	cd src-tauri && cargo test writes_contract_fixture
