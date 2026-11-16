/**
 * INV-20: the audit log is a hash chain and `agni audit verify` finds a
 * tampered row (S2-12; track-c C5.4 item 20 and the S16 test).
 *
 *   - Every decision the gate makes is written, with its tool and a reason.
 *   - `agni audit verify` passes on an untouched log.
 *   - Change one byte of one row, or remove a row from the middle, and it fails.
 *
 * The table name (`audit_events`, migration 56) and the command come from the
 * spec; the columns are not specified, so the test finds a text column to
 * damage from the table's own definition.
 */
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { call, playTurn, scripted, useWeb } from "./support";

const scenarios = useScenarios();
useWeb();

const SERVER_INDEX = join(import.meta.dir, "..", "..", "src", "index.ts");

async function agni(s: Scenario, ...args: string[]): Promise<{ code: number; text: string }> {
  const child = Bun.spawn(["bun", SERVER_INDEX, ...args], {
    env: { ...process.env, AGNI_HOME: s.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, text: `${out}${err}` };
}

function auditRows(s: Scenario): Array<Record<string, unknown>> {
  try {
    return s.all<Record<string, unknown>>("SELECT rowid AS _rowid, * FROM audit_events ORDER BY rowid");
  } catch (error) {
    throw new Error(`there is no audit log to read (${error instanceof Error ? error.message : String(error)}); migration 56 waits for S2-12`);
  }
}

/** A turn with decisions in it: a send asked about and refused, a write outside scratch asked about and refused. */
async function makeSomeDecisions(s: Scenario): Promise<void> {
  const a = await s.connect({ label: "A" });
  s.model.queue(...scripted(true, [
    call("write_file", { path: s.outside("audit-a.txt"), content: "a" }, "call_audit_a"),
    call("mail_send", { account: "owner", to: ["friend@example.org"], subject: "hi", body: "hello" }, "call_audit_b"),
    call("bash", { command: `touch ${s.outside("audit-c").replaceAll("\\", "/")}` }, "call_audit_c"),
    say("Done."),
  ]));
  await playTurn(s, a, "do three things that need my say-so");
}

/** A text column that is not part of the chain bookkeeping, to damage. */
function damageableColumn(s: Scenario): string {
  const columns = s.all<{ name: string; type: string }>("SELECT name, type FROM pragma_table_info('audit_events')");
  const preferred = ["detail", "payload", "data", "reason", "kind", "event", "tool"];
  const byName = preferred.map((name) => columns.find((column) => column.name === name)).find(Boolean);
  const text = columns.find((column) => /text/i.test(column.type) && !/hash|sig|prev|checksum|id$/i.test(column.name));
  const chosen = byName ?? text;
  if (!chosen) throw new Error(`no text column to damage in audit_events (${columns.map((c) => c.name).join(", ")})`);
  return chosen.name;
}

// waits for S2-2 (S2-12: migration 56 `audit_events`, hash chain, `agni audit verify`)
describe("INV-20 the audit log records decisions and verifies as a chain", () => {
  scenarioTest("each decision is written with its tool and a reason", async () => {
    const s = await scenarios.start();
    await makeSomeDecisions(s);
    const rows = auditRows(s);
    expect(rows.length, "no audit rows were written for three gated calls").toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(rows);
    for (const tool of ["write_file", "mail_send", "bash"]) expect(text, `no audit row names ${tool}`).toContain(tool);
    expect(text, "audit rows carry no reason for the decision").toMatch(/reason/i);
  });

  scenarioTest("`agni audit verify` passes on an untouched log", async () => {
    const s = await scenarios.start();
    await makeSomeDecisions(s);
    expect(auditRows(s).length).toBeGreaterThan(0);
    const result = await agni(s, "audit", "verify");
    expect(result.code, `verify failed on a log nobody touched: ${result.text.slice(-300)}`).toBe(0);
  });

  scenarioTest("flipping one byte of one row makes `agni audit verify` fail and name the break", async () => {
    const s = await scenarios.start();
    await makeSomeDecisions(s);
    const rows = auditRows(s);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const middle = rows[Math.floor(rows.length / 2)]!;
    const column = damageableColumn(s);
    const original = String(middle[column] ?? "");
    const flipped = original.length > 0 ? `${original.slice(0, -1)}${original.endsWith("x") ? "y" : "x"}` : "x";
    s.db.run(`UPDATE audit_events SET ${column} = ? WHERE rowid = ?`, [flipped, middle._rowid as number]);

    const result = await agni(s, "audit", "verify");
    expect(result.code, "verify passed on a log with a modified row").not.toBe(0);
    expect(result.text, "verify failed without saying where").toMatch(new RegExp(`${String(middle.id ?? middle.seq ?? middle._rowid)}|row|line|seq|index`, "i"));
  });

  scenarioTest("removing a row from the middle makes `agni audit verify` fail", async () => {
    const s = await scenarios.start();
    await makeSomeDecisions(s);
    const rows = auditRows(s);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    s.db.run("DELETE FROM audit_events WHERE rowid = ?", [rows[Math.floor(rows.length / 2)]!._rowid as number]);
    const result = await agni(s, "audit", "verify");
    expect(result.code, "verify passed on a log with a missing row").not.toBe(0);
  });
});
