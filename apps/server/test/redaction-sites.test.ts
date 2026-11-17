/**
 * Sprint 2 persists and shows text in a few places (tool arguments and results, the message log,
 * approval card previews). Sprint 3 gives `redact()` its body; until then it returns its input, so a
 * behaviour test cannot see it. This pins that those places go through it, so the day it masks a
 * secret nothing here leaks one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string): string => readFileSync(join(import.meta.dir, "..", "src", path), "utf8").replace(/\r\n/g, "\n");

describe("text that is stored or shown goes through redact()", () => {
  const loop = read("agent/task-loop.ts");
  const broker = read("agent/approval-broker.ts");

  test("tool arguments and results are redacted before they are stored", () => {
    expect(loop).toContain("redact(JSON.stringify(args))");
    expect(loop).toContain("[redact(content), ok ? 1 : 0, error");
  });

  test("the message log is redacted when the session is saved", () => {
    expect(loop.match(/redact\(JSON\.stringify\(messages\)\)/g)).toHaveLength(2);
  });

  test("the activity preview is redacted", () => {
    expect(loop).toContain("preview: redact(describePreview(call.function.name, args))");
  });

  test("approval cards and their audit rows are redacted", () => {
    expect(broker).toContain("const action = redact(describeAction(toolName, args));");
    expect(broker).toContain("const preview = redact(`${lead}");
    expect(broker).toContain("const preview = redact(note ?");
  });
});
