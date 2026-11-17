/**
 * The fixture server serves only pages inside its root, and the preload's
 * routing sends the fixture host to 127.0.0.1 only on the fixture port.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureFile, fixturePortFrom, fixtureRoute, startWebFixtures } from "../web-fixtures";

const work = mkdtempSync(join(tmpdir(), "agni-eval-webfix-test-"));
const root = join(work, "root");
mkdirSync(join(root, "ep"), { recursive: true });
writeFileSync(join(root, "ep", "info.html"), "<p>fixture page</p>");
// A file next to the root, which no request may reach.
writeFileSync(join(work, "secret.html"), "SECRET");
const web = startWebFixtures(root);
afterAll(() => {
  web.stop();
  rmSync(work, { recursive: true, force: true });
});
const get = (path: string) => fetch(`http://127.0.0.1:${web.port}${path}`);

describe("fixture server", () => {
  test("a page inside the root is served", async () => {
    const res = await get("/ep/info");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture page");
  });

  for (const path of [
    "/..%5Csecret",
    "/ep/..%5C..%5Csecret",
    "/ep%5C..%5C..%5Csecret",
    "/C:%5Csecret",
    "/C:secret",
    "/..%2Fsecret",
    "/ep/%2e%2e/%2e%2e/secret",
    "/ep/info%00",
    "/%E0%A4%A",
  ]) {
    test(`an escape attempt is not served: ${path}`, async () => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    });
  }

  test("the file check refuses backslashes, colons, `..` and anything resolving outside the root", () => {
    expect(fixtureFile(root, "/ep/info")).toBe(join(root, "ep", "info.html"));
    for (const p of ["/..\\secret", "/ep\\..\\..\\secret", "/C:\\secret", "/c:secret", "/ep:stream", "/../secret", "/ep//info", "/"]) {
      expect(fixtureFile(root, p)).toBeNull();
    }
  });
});

describe("preload routing", () => {
  const route = (url: string, port: number | null) => {
    const u = new URL(url);
    return fixtureRoute({ protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? "443" : "80") }, port);
  };

  test("only plain http to the fixture host on the fixture port goes local", () => {
    expect(route("http://fixtures.example:4000/ep/a", 4000)).toBe("local");
    expect(route("http://FIXTURES.example:4000/ep/a", 4000)).toBe("local");
  });

  test("the fixture host on another port, over https, on the default port, or with no port known is refused", () => {
    expect(route("http://fixtures.example:4001/ep/a", 4000)).toBe("refuse");
    expect(route("http://fixtures.example:8787/", 4000)).toBe("refuse");
    expect(route("http://fixtures.example/ep/a", 4000)).toBe("refuse");
    expect(route("https://fixtures.example:4000/ep/a", 4000)).toBe("refuse");
    expect(route("http://fixtures.example:4000/ep/a", null)).toBe("refuse");
  });

  test("other hosts are left alone", () => {
    expect(route("https://example.com/", 4000)).toBe("pass");
    expect(route("http://fixtures.example.evil.com:4000/", 4000)).toBe("pass");
  });

  test("the port comes from AGNI_EVAL_FIXTURE_PORT and must be a port number", () => {
    expect(fixturePortFrom({ AGNI_EVAL_FIXTURE_PORT: "4000" })).toBe(4000);
    expect(fixturePortFrom({})).toBeNull();
    expect(fixturePortFrom({ AGNI_EVAL_FIXTURE_PORT: "0" })).toBeNull();
    expect(fixturePortFrom({ AGNI_EVAL_FIXTURE_PORT: "70000" })).toBeNull();
    expect(fixturePortFrom({ AGNI_EVAL_FIXTURE_PORT: "4000abc" })).toBeNull();
  });
});
