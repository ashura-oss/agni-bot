/**
 * Sprint 2, fix round J: what a card says, and how the client is told to make the owner read it.
 *
 *  5. A URL on a card is shown as the server will resolve it (the host in punycode, the path escaped), with a "Written as" line when
 *     the model wrote it some other way. This covers a routine's HTTP preflight and the `web_fetch` card.
 *  7. The audit row of a call a stored rule let through says why the call was not shown whole: the reason, not a fixed one.
 *  8. One schedule check serves the engine, the card and the tool.
 *  9. A card the owner could not take in at a glance (over 2,000 characters or 40 lines) is marked `truncated`: the owner opens the
 *     full text before Allow, and `approval.full` returns the whole preview.
 */
import { describe, expect, test } from "bun:test";
import { previewAction } from "../src/agent/card-preview";

const bot = "Ava";

describe("a URL on a card is shown as it will be resolved, and as it was written when that differs", () => {
  const written = "https://bücher.example/Pfad?q=ä";
  const resolved = "https://xn--bcher-kva.example/Pfad?q=%C3%A4";

  test("a routine's HTTP preflight shows the resolved address and the written one", () => {
    const create = { name: "Watch", prompt: "Look.", cron: "0 9 * * *", timezone: "UTC", preflight: { kind: "http", url: written } };
    const preview = previewAction("routine_create", create, bot);
    expect(preview, "the card does not show the address the server will fetch").toContain(`Before each run: it fetches ${resolved}`);
    expect(preview, "the card does not say how the address was written").toContain(`Written as: ${written}`);
  });

  test("an address already in its resolved form has no Written as line", () => {
    const create = { name: "Watch", prompt: "Look.", cron: "0 9 * * *", timezone: "UTC", preflight: { kind: "http", url: "https://example.com/status" } };
    const preview = previewAction("routine_create", create, bot);
    expect(preview).toContain("Before each run: it fetches https://example.com/status");
    expect(preview).not.toContain("Written as:");
  });

  test("a web_fetch card shows the address the server will fetch, with the written form when it differs", () => {
    const preview = previewAction("web_fetch", { url: "HTTPS://Bücher.Example/a b", maxChars: 4_000 }, bot);
    expect(preview).toContain("Fetches: https://xn--bcher-kva.example/a%20b");
    expect(preview).toContain("Written as: HTTPS://Bücher.Example/a b");
    expect(preview, "an argument beside the address is not named").toContain("maxChars = 4000");
  });

  test("a web_fetch address that is already resolved has no Written as line, and one that cannot be read says so", () => {
    expect(previewAction("web_fetch", { url: "https://example.com/a" }, bot)).not.toContain("Written as:");
    const broken = previewAction("web_fetch", { url: "not a url" }, bot);
    expect(broken).toContain("not a url");
    expect(broken).toMatch(/not an address/i);
  });

  test("a confusable host cannot pass for the real one: the owner reads the punycode", () => {
    const preview = previewAction("web_fetch", { url: "https://exаmple.com/login" }, bot);
    expect(preview, "the Cyrillic look-alike was shown as the plain address").toContain("Fetches: https://xn--");
    expect(preview).toContain("Written as: https://exаmple.com/login");
  });
});
