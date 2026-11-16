import { log } from "../log";
import { prepareGitBash } from "../util/git-bash";

/**
 * Start checking Git Bash in the background (S2-14). On Windows the shell runs through a per-user Git install only
 * when no other account can write to it; reading those permissions starts PowerShell, so it is done here, once, at
 * server start, and never makes a shell command wait. Not awaited: a slow or failed check cannot hold the server up.
 */
export function startupS2Shell(options: { platform?: string; prepare?: () => Promise<void> } = {}): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  const prepare = options.prepare ?? (() => prepareGitBash());
  void prepare().catch((error) => {
    log.warn(`git bash check at start-up failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
