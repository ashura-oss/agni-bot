/**
 * The preload, loaded into a real Bun child the way the eval server loads it:
 * the fixture host reaches the fixture server on its own port only. On any
 * other port (here: a second local service) or over https it is refused, and
 * with no port set it is refused everywhere.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanChildEnv } from "../../../apps/server/test/test-child-env";
import { PRELOAD } from "../server";
import { FIXTURE_PORT_ENV, startWebFixtures } from "../web-fixtures";

const work = mkdtempSync(join(tmpdir(), "agni-eval-preload-test-"));
mkdirSync(join(work, "web", "ep"), { recursive: true });
writeFileSync(join(work, "web", "ep", "info.html"), "<p>fixture page</p>");
const web = startWebFixtures(join(work, "web"));
// Another local service: the preload must never route the fixture host to it.
const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("LOCAL SECRET SERVICE") });
afterAll(() => {
  web.stop();
  void other.stop(true);
  rmSync(work, { recursive: true, force: true });
});

const fetchUrlModule = pathToFileURL(resolve(import.meta.dir, "../../../apps/server/src/tools/fetch-url.ts")).href;
const script = `
import http from "node:http";
import https from "node:https";
const { resolver } = await import(${JSON.stringify(fetchUrlModule)});
const get = (mod, url) => new Promise((done) => {
  try {
    const req = mod.request(new URL(url), { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => done({ status: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on("error", (e) => done({ error: String(e.message) }));
    req.end();
  } catch (e) {
    done({ error: String(e.message) });
  }
});
const out = {
  fixture: await get(http, "http://fixtures.example:${web.port}/ep/info"),
  otherPort: await get(http, "http://fixtures.example:${other.port}/"),
  https: await get(https, "https://fixtures.example:${web.port}/ep/info"),
  lookup: await resolver.lookup("fixtures.example", { all: true }).then((a) => a.length, () => "error"),
};
console.log(JSON.stringify(out));
`;
const scriptPath = join(work, "probe.ts");
writeFileSync(scriptPath, script);

/** Run the probe in a child. Async on purpose: the fixture server lives in this process and must keep answering. */
async function runWith(env: Record<string, string>): Promise<any> {
  const child = Bun.spawn([process.execPath, "--preload", PRELOAD, scriptPath], {
    env: cleanChildEnv({ AGNI_TEST_RUN: "1", ...env }),
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`probe printed no result. stdout: ${stdout.slice(0, 300)} stderr: ${stderr.slice(0, 300)}`);
  }
}

describe("eval preload in a child process", () => {
  test("with the fixture port set: the fixture page is served; another local port and https are refused", async () => {
    const out = await runWith({ [FIXTURE_PORT_ENV]: String(web.port) });
    expect(out.fixture.status).toBe(200);
    expect(out.fixture.body).toContain("fixture page");
    expect(out.otherPort.error).toContain("refused");
    expect(JSON.stringify(out.otherPort)).not.toContain("LOCAL SECRET SERVICE");
    expect(out.https.error).toContain("refused");
    expect(out.lookup).toBe(1);
  }, 30_000);

  test("with no fixture port set: every request to the fixture host is refused and its lookup fails", async () => {
    const out = await runWith({});
    expect(out.fixture.error).toContain("refused");
    expect(out.otherPort.error).toContain("refused");
    expect(out.lookup).toBe("error");
  }, 30_000);
});
