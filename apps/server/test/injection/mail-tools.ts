/**
 * Helpers for the mail injection tests: the real tool registry, built the way
 * the task loop builds it, with fixed mailbox credentials and the fake mail
 * network in place of TLS.
 *
 * Not a test file (no `.test.`), so bun does not collect it.
 */
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../src/db";
import type { MailAccountResolver } from "../../src/plugins/credentials";
import { buildTaskToolRegistry } from "../../src/tools/task-registry";
import type { ToolRegistry } from "../../src/tools/registry";
import { installFakeMailNetwork, type FakeMailNetwork } from "./fake-mail-network";

export const ctx = { threadID: "thr_inj", turnID: "trn_inj", signal: new AbortController().signal };

export interface MailRig {
  db: Database;
  registry: ToolRegistry;
  network: FakeMailNetwork;
  /** Run a tool the way the task loop does: through the registry's argument check, then the handler. */
  call(name: string, args: unknown): Promise<{ threw: string | null; result: Record<string, unknown> | null }>;
  close(): void;
}

export function mailRig(options: { accounts?: MailAccountResolver; searchHits?: number[] } = {}): MailRig {
  const db = openDatabase(":memory:");
  const accounts: MailAccountResolver = options.accounts ?? (() => ({ user: "agent@example.test", pass: "app-password" }));
  const registry = buildTaskToolRegistry(db, accounts);
  const network = installFakeMailNetwork(options.searchHits ? { searchHits: options.searchHits } : {});
  return {
    db,
    registry,
    network,
    async call(name, args) {
      const tool = registry.get(name);
      if (!tool) throw new Error(`no such tool: ${name}`);
      try {
        const result = await (tool.handler as (a: unknown, c: typeof ctx) => Promise<unknown>)(args, ctx);
        return { threw: null, result: result as Record<string, unknown> };
      } catch (error) {
        return { threw: error instanceof Error ? error.message : String(error), result: null };
      }
    },
    close() {
      network.restore();
      db.close();
    },
  };
}

/** True when the call was turned away: it threw, or answered with an `error`. */
export function refused(outcome: { threw: string | null; result: Record<string, unknown> | null }): boolean {
  return outcome.threw !== null || (outcome.result !== null && typeof outcome.result.error === "string");
}
