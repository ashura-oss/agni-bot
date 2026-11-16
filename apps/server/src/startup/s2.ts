import type { StartupContext } from "./context";
import { startupS2Audit } from "./s2-audit";
import { startupS2Ledger } from "./s2-ledger";

/** Sprint 2 startup work (audit sink, usage recorder). Called once from `serve()`; each task owns its own file. */
export async function startupS2(ctx: StartupContext): Promise<void> {
  await startupS2Audit(ctx);
  await startupS2Ledger(ctx);
}
