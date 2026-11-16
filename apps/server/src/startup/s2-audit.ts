import { cancelTurnsForPause } from "../ws/turn-registry";
import { bindPauseStore, isRunPaused, listBotStates } from "../policy/pause";
import { log } from "../log";
import { installAuditSink } from "../stores/audit";
import type { StartupContext } from "./context";

/** How often the daemon checks for a pause made from another process (`agni pause`). */
const WATCH_MS = 1_000;

let watcher: ReturnType<typeof setInterval> | undefined;

/** Stop the pause watcher (tests; shutdown). */
export function stopPauseWatcher(): void {
  if (watcher !== undefined) clearInterval(watcher);
  watcher = undefined;
}

/** Stop every running turn the pause covers: all of them when paused, else the bots that are off. */
export function enforcePause(ctx: Pick<StartupContext, "db">): number {
  if (isRunPaused({ agentID: null }).paused) return cancelTurnsForPause("paused");
  let stopped = 0;
  for (const bot of listBotStates(ctx.db)) {
    if (!bot.enabled) stopped += cancelTurnsForPause("agent_off", bot.agentID);
  }
  return stopped;
}

/**
 * Sprint 2 audit and pause startup: the audit log becomes the real sink, the
 * pause state is bound to this database, and a watcher stops turns that a
 * pause made from the CLI should end (the frame handlers stop them at once).
 */
export async function startupS2Audit(ctx: StartupContext): Promise<void> {
  installAuditSink(ctx.db);
  bindPauseStore(ctx.db);
  stopPauseWatcher();
  watcher = setInterval(() => {
    try {
      enforcePause(ctx);
    } catch (error) {
      // The database was closed under us (shutdown): there is nothing left to watch.
      if (error instanceof Error && /closed database/i.test(error.message)) return stopPauseWatcher();
      log.warn("pause watcher failed", error);
    }
  }, WATCH_MS);
  watcher.unref?.();
}
