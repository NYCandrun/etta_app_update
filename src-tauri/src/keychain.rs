//! API-key storage in the OS keychain via the `keyring` crate ONLY.
//!
//! The key is NEVER written to SQLite, never to a file, never XOR'd/obfuscated
//! (blocklist #39). The `settings.api_key_present` boolean flag is the only
//! thing persisted in the DB; the key material lives solely in the keychain.
//! Service id MUST be `com.etta.app` (#39). `test_api_key` reads the STORED key
//! rather than taking it as a parameter, so the key is never a logged argument
//! (#40).

use std::sync::OnceLock;

use keyring::Entry;

/// Keychain service id. MUST be `com.etta.app` — never a legacy name.
pub const SERVICE: &str = "com.etta.app";
/// Account/username under the service for the single API key entry.
pub const ACCOUNT: &str = "anthropic_api_key";

// One shared Entry handle for the single API-key credential. Created once and
// reused so every op targets the same (service, user) credential. (The
// in-memory mock store used in tests keeps its state inside the credential
// object, so reuse is required for the test to observe a real set/get/delete
// cycle; real OS keychains persist by (service, user) regardless.)
static ENTRY: OnceLock<Entry> = OnceLock::new();

fn entry() -> Result<&'static Entry, String> {
    if let Some(e) = ENTRY.get() {
        return Ok(e);
    }
    let e = Entry::new(SERVICE, ACCOUNT).map_err(|err| {
        // Never include the key in errors; this path has none anyway.
        tracing::error!(error = %err, "keychain entry init failed");
        "keychain unavailable".to_string()
    })?;
    // If two threads race, the first wins; either handle is equivalent.
    Ok(ENTRY.get_or_init(|| e))
}

/// Store the API key in the keychain. The caller (command layer) sets the
/// `api_key_present` flag on success.
pub fn set_key(key: &str) -> Result<(), String> {
    entry()?.set_password(key).map_err(|e| {
        tracing::error!(error = %e, "keychain store failed");
        "failed to store API key".to_string()
    })?;
    tracing::info!("api key stored in keychain");
    Ok(())
}

/// Read the stored key, if present. Returns None when no key is set.
pub fn get_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            tracing::error!(error = %e, "keychain read failed");
            Err("failed to read API key".to_string())
        }
    }
}

/// Remove the key from the keychain. Idempotent: a missing entry is success.
pub fn delete_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => {
            tracing::info!("api key removed from keychain");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            tracing::error!(error = %e, "keychain delete failed");
            Err("failed to delete API key".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    // Route keychain ops to the in-memory mock store so the set/has/delete
    // cycle runs in headless CI without a real OS keychain.
    static INIT: Once = Once::new();
    fn use_mock() {
        INIT.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    /// Keychain set -> has -> delete cycle (acceptance criterion).
    #[test]
    fn set_has_delete_cycle() {
        use_mock();
        // Clean slate.
        let _ = delete_key();
        assert_eq!(get_key().unwrap(), None, "no key initially");

        set_key("sk-ant-test-123").unwrap();
        assert_eq!(get_key().unwrap().as_deref(), Some("sk-ant-test-123"));

        delete_key().unwrap();
        assert_eq!(get_key().unwrap(), None, "key removed after delete");

        // Delete again is idempotent.
        delete_key().unwrap();
    }
}
