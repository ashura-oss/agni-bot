/**
 * Secret redaction: the surface production code imports. The implementation, and the two functions that exist
 * only so tests can start from an empty registry (`clearSecretsForTests`, `unregisterSecret`), are in
 * `redact-core.ts`; tests import those from there, and `test/s3-redact-surface.test.ts` checks that no
 * production file does. `redact` and `registerSecret` are frozen shared API; read `redact-core.ts` for how the
 * registry works.
 */
export {
  MAX_SECRETS,
  MIN_SECRET_LENGTH,
  REDACTED,
  RETIRED_MAX,
  RETIRED_PER_SLOT,
  forgetSecretSlots,
  holdbackLength,
  redact,
  registerSecret,
  registerSecretFor,
  registerSecretsFromEnv,
  releaseExpiredSecrets,
  releaseSecretFor,
  rememberSecretsAt,
  secretCount,
  secretEnvNames,
  stageSecretsAt,
} from "./redact-core";
export type { SlotSecret } from "./redact-core";
