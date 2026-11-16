import { Router } from "../src/models/router.ts";
import { createMemoryKeyStore, setKeyStoreOverride } from "../src/secrets";

// Retries still run in tests, just without the 2s wait between them.
Router.retryBackoffMs = 0;

// No test may reach the real credential store (Windows Credential Manager,
// macOS Keychain, libsecret). Every vault a test unlocks uses this in-memory
// keystore unless the test passes its own `keystore` option.
setKeyStoreOverride(createMemoryKeyStore());
