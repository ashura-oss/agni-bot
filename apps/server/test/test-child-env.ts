/**
 * The environment a test gives a child process it starts (`serve`, `agni vault ...`): everything of the test process's
 * own except what would let the child reach the owner's home or keys. `AGNI_TEST_RUN` is the one `AGNI_*` name that
 * stays, so the child is a test run too and refuses the operating system's credential store (`refuseInTestRun`).
 * Every test that starts a child builds its environment here, not with a strip of its own.
 */
import { TEST_RUN_VARIABLE } from "../src/secrets/bun-secrets";

/** The default: the `AGNI_*` settings and anything that looks like a credential. */
export const AGNI_AND_CREDENTIALS = /^AGNI_|API_KEY|TOKEN|SECRET|PASSWORD|^GROQ|^CEREBRAS|^NVIDIA|^OPENROUTER/i;

/** Only the `AGNI_*` settings, for a child that must still see the ambient credential-looking names. */
export const AGNI_ONLY = /^AGNI_/i;

/** `source` (default: this process's environment) without the names `strip` matches, except the test-run marker, plus `extra`. */
export function cleanChildEnv(
  extra: Record<string, string> = {},
  strip: RegExp = AGNI_AND_CREDENTIALS,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name.toUpperCase() !== TEST_RUN_VARIABLE && strip.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}
