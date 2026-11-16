import { log } from "../../../apps/server/src/log";
import { redact } from "../../../apps/server/src/util/redact";

export function positive(apiKey: string, config: { password: string }, headers: Headers): void {
  // ruleid: agni-secret-in-log
  console.log(apiKey);
  // ruleid: agni-secret-in-log
  console.error("failed with key", apiKey);
  // ruleid: agni-secret-in-log
  log.info(`connecting with ${config.password}`);
  // ruleid: agni-secret-in-log
  log.warn("headers", headers.get("authorization"));
  // ruleid: agni-secret-in-log
  log.debug("env", process.env.OPENROUTER_API_KEY);
}

export function negative(apiKey: string, usage: { totalTokens: number }): void {
  // ok: agni-secret-in-log
  log.info("key length", apiKey.length);
  // ok: agni-secret-in-log
  console.log(redact(apiKey));
  // ok: agni-secret-in-log
  log.info("tokens used", usage.totalTokens);
  // ok: agni-secret-in-log
  log.info(`has key: ${apiKey.length > 0}`);
}
