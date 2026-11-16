import { afterEach } from "bun:test";
import { resetSecretSlots } from "../src/credentials/vault-mode";
import { clearSecretsForTests } from "../src/util/redact.ts";
import { Router } from "../src/models/router.ts";
import { createMemoryKeyStore, setKeyStoreOverride } from "../src/secrets";

// Retries still run in tests, just without the 2s wait between them.
Router.retryBackoffMs = 0;

// No test may reach the real credential store (Windows Credential Manager,
// macOS Keychain, libsecret). Every vault a test unlocks uses this in-memory
// keystore unless the test passes its own `keystore` option.
setKeyStoreOverride(createMemoryKeyStore());

// The redaction registry is process-wide. What one test registers must not change what the next one
// sees (a secret count, a stream tail held back because it starts like a leftover secret), so every test
// ends with an empty registry. Slots (`rememberSecretsAt`) forget their values with it.
afterEach(() => {
  clearSecretsForTests();
  resetSecretSlots();
});
