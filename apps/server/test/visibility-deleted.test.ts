/**
 * Carried from Sprint 1: when the bot that wrote something is gone (deleted), what it wrote is
 * private, not "summary". A bot that no longer exists cannot say what it was willing to share.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { MISSING_AGENT_VISIBILITY } from "../src/agent/visibility";
import { registerArtifactTool } from "../src/tools/artifact-tool";
import { ToolRegistry } from "../src/tools/registry";
import { saveArtifact } from "../src/stores/artifacts";
import { groupHistory } from "../src/agent/group";
import { appendChannelMessage } from "../src/stores/channels";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });
const ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };

describe("a deleted bot's words are private", () => {
  test("the visibility of a missing bot is private", () => {
    expect(MISSING_AGENT_VISIBILITY).toBe("private");
  });

  test("read_artifact on a deleted bot's artifact gives a receipt, not the text", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerArtifactTool(registry, { db, currentAgentID: "ea" });
    const artifact = saveArtifact(db, { agentID: "ghost", content: "What the deleted bot found out." });
    const read = registry.get("read_artifact")!.handler as unknown as (a: unknown, c: unknown) => Promise<{ text: string | null; redacted: boolean; visibility: string }>;
    const out = await read({ artifactRef: artifact.id }, ctx);
    expect(out).toMatchObject({ text: null, redacted: true, visibility: "private" });
  });

  test("a group room shows a deleted bot's line as a private reply", () => {
    db = openDatabase(":memory:");
    db.run("INSERT INTO channels (id, name, agent_id, created_at, updated_at) VALUES ('grp_1', 'Team', 'ea', '2026-11-16T10:00:00Z', '2026-11-16T10:00:00Z')");
    appendChannelMessage(db, { channelID: "grp_1", fromType: "agent", fromID: "ghost", text: "secret findings", uiHint: "normal" });
    const lines = groupHistory(db, "grp_1", "ea");
    expect(lines.join("\n")).not.toContain("secret findings");
    expect(lines.join("\n")).toContain("(replied; private)");
  });

});
