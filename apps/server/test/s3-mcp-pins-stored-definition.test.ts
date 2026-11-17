/**
 * Sprint 3 fix round 8: the stored MCP definition is masked as JSON, not as a blob.
 *
 * The definition is the server's own text, kept so the owner can see a diff. A registered value equal to JSON
 * syntax corrupted it when it was masked as one blob, and a duplicate key could carry a secret past a walk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { canonicalDefinition, listPins, memoryPins, reconcilePins } from "../src/plugins/mcp-pins";
import { REDACTED, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";

const SECRET = "dupkey-secret-Zk93-tail";
const BIG = "12345678901234567890";

afterEach(() => {
  clearSecretsForTests();
});

describe("the stored MCP definition", () => {
  const offered = (definition: string) => [{ tool: "search", hash: "hash-of-what-was-offered", definition }];

  test("a registered value that equals JSON syntax leaves the stored definition valid and unchanged", () => {
    const syntax = '},"name":"';
    registerSecret(syntax);
    const definition = canonicalDefinition({ name: "search", description: "Search the web", inputSchema: { type: "object" } });
    expect(definition).toContain(syntax);
    const pins = memoryPins();
    reconcilePins(pins, "notion", offered(definition));
    const [pin] = listPins(pins, "notion");
    expect(() => JSON.parse(pin!.definition)).not.toThrow();
    expect(pin!.definition).toBe(definition);
  });

  test("a bearer echoed into the description is masked and the definition stays valid, with its big numbers exact", () => {
    registerSecret(SECRET);
    const definition = canonicalDefinition({
      name: "search",
      description: `Search. Debug: ${SECRET}`,
      inputSchema: { type: "object", properties: { limit: { type: "integer", maximum: 1 } } },
    }).replace('"maximum":1', `"maximum":${BIG}`);
    const pins = memoryPins();
    reconcilePins(pins, "notion", offered(definition));
    const [pin] = listPins(pins, "notion");
    expect(pin!.definition).not.toContain(SECRET);
    expect(pin!.definition).toContain(REDACTED);
    expect(pin!.definition).toContain(`"maximum":${BIG}`);
    // The hash is the one the caller computed over the definition as offered.
    expect(pin!.hash).toBe("hash-of-what-was-offered");
  });

  test("a duplicate key in the definition cannot carry the secret into the stored copy", () => {
    registerSecret(SECRET);
    const definition = `{"description":"${SECRET}","description":"x","name":"search"}`;
    const pins = memoryPins();
    reconcilePins(pins, "notion", offered(definition));
    expect(listPins(pins, "notion")[0]!.definition).not.toContain("Zk93");
  });
});
