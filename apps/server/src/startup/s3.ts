import type { StartupContext } from "./context";
import { startupS3Secrets } from "./s3-secrets";
import { startupS3Vault } from "./s3-vault";

/** Sprint 3 startup work. Called once from `serve()`; each task owns its own file. */
export async function startupS3(ctx: StartupContext): Promise<void> {
  await startupS3Vault(ctx);
  await startupS3Secrets(ctx);
}
