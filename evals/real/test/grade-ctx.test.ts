import { afterEach, describe, expect, test } from "bun:test";
import { toolRows } from "../util";
import { makeGradeHarness, type GradeHarness } from "./grade-ctx";

const open: GradeHarness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

describe("grading harness", () => {
  test("rows written with the real schema read back through the graders' queries", () => {
    const h = makeGradeHarness();
    open.push(h);
    h.addAgent("ledger_bot", "Ledger", ["read_file"]);
    const turn = h.addTurn("ledger_bot");
    const callId = h.addToolCall({ tool: "read_file", args: { path: "data/products.csv" }, turn, result: "name,price" });
    h.addApproval({ tool: "bash", action: "run shell: rm x", decision: "reject", callId });
    h.addJob({ kind: "turn", payload: { agentID: "ea", text: "x" }, state: "queued", runAt: "2026-11-18T10:00:00.000Z" });
    const rows = toolRows(h.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "read_file", agent: "ledger_bot", ok: 1, callId, args: { path: "data/products.csv" } });
    const db = h.ctx.db();
    try {
      expect(db.query("SELECT decision FROM approvals WHERE call_id = ?").get(callId)).toEqual({ decision: "reject" });
      expect(db.query("SELECT COUNT(*) n FROM jobs").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
