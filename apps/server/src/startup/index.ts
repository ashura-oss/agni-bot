import type { StartupContext } from "./context";
import { startupS2 } from "./s2";
import { startupS3 } from "./s3";

export type { StartupContext } from "./context";

export type StartupHook = (ctx: StartupContext) => Promise<void>;

/** Run each sprint's startup hook once, in order. `serve()` calls this after the database is open. */
export async function runStartupHooks(
  ctx: StartupContext,
  hooks: StartupHook[] = [startupS2, startupS3],
): Promise<void> {
  for (const hook of hooks) await hook(ctx);
}
