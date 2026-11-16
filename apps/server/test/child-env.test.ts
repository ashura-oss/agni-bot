/**
 * S2-14: every child process gets an environment built from an allowlist and
 * a fixed PATH. Nothing the server happens to hold (provider keys, mail
 * passwords, tokens, a poisoned PATH) reaches a child unless a name is listed
 * in `util/child-env.ts`. Every value here is made up.
 */
import { describe, expect, test } from "bun:test";
import { providerKeyEnvNames } from "../src/models/providers";
import { childEnv, childPath } from "../src/util/child-env";

const FAKE = "fake-key-value-do-not-use-0123456789";

const WIN_SOURCE = {
  SystemRoot: "C:\\Windows", windir: "C:\\Windows", SystemDrive: "C:",
  ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
  USERPROFILE: "C:\\Users\\o", TEMP: "C:\\Users\\o\\Temp", TMP: "C:\\Users\\o\\Temp",
  Path: "C:\\evil;.;;relative\\bin;C:\\Users\\o\\bin;C:\\Windows\\System32",
  LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "C", TZ: "UTC",
  OPENROUTER_API_KEY: FAKE, GMAIL_APP_PASSWORD: FAKE, AGNI_HOME: "C:\\h", AGNI_TOKEN: FAKE,
  RANDOM_THING: "x", NPM_CONFIG_USERCONFIG: "C:\\npmrc", GITHUB_TOKEN: FAKE,
};
const GIT = "C:\\Program Files\\Git";
const WIN_PATH = [
  `${GIT}\\usr\\bin`, `${GIT}\\bin`,
  "C:\\Windows\\System32", "C:\\Windows", "C:\\Windows\\System32\\Wbem",
].join(";");

describe("childPath", () => {
  test("Windows: Git for Windows from the fixed root, then the system directories; the server's PATH is ignored", () => {
    expect(childPath({ source: WIN_SOURCE, platform: "win32", gitRoot: GIT })).toBe(WIN_PATH);
  });

  test("Windows without Git: system directories only; without SystemRoot nothing is guessed", () => {
    expect(childPath({ source: WIN_SOURCE, platform: "win32", gitRoot: null })).toBe("C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem");
    expect(childPath({ source: {}, platform: "win32", gitRoot: GIT })).toBe(`${GIT}\\usr\\bin;${GIT}\\bin`);
  });

  test("POSIX: the system directories only, never what the server inherited", () => {
    expect(childPath({ source: { PATH: "/tmp/evil:." }, platform: "linux" })).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(childPath({ platform: "darwin" })).toBe("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("never an empty, '.', or relative entry, even if one is asked for", () => {
    const path = childPath({ source: WIN_SOURCE, platform: "win32", gitRoot: GIT, prepend: ["", ".", "..\\x", "rel\\dir", "C:\\Secret\\Dir"] });
    const entries = path.split(";");
    expect(entries[0]).toBe("C:\\Secret\\Dir");
    for (const entry of entries) expect(/^[A-Za-z]:\\/.test(entry)).toBe(true);
    const posix = childPath({ platform: "linux", prepend: ["", ".", "bin", "/tmp/ok"] }).split(":");
    expect(posix[0]).toBe("/tmp/ok");
    for (const entry of posix) expect(entry.startsWith("/")).toBe(true);
  });

  test("a relative or empty ProgramFiles or SystemRoot never becomes a PATH entry", () => {
    const path = childPath({ source: { SystemRoot: "Windows", ProgramFiles: "" }, platform: "win32", gitRoot: null });
    expect(path).toBe("");
  });
});

describe("childEnv allowlist", () => {
  test("shell: only listed names pass, PATH is the fixed one, secrets and strangers are dropped", () => {
    const env = childEnv("shell", { source: WIN_SOURCE, platform: "win32", gitRoot: GIT });
    expect(Object.keys(env).sort()).toEqual(
      ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ", "USERPROFILE", "windir", "ProgramFiles", "ProgramFiles(x86)"].sort(),
    );
    expect(env.PATH).toBe(WIN_PATH);
  });

  test("shell: every provider key variable is dropped even when it is the only thing set", () => {
    const names = providerKeyEnvNames();
    expect(names.length).toBeGreaterThanOrEqual(5);
    const env = childEnv("shell", { source: { ...Object.fromEntries(names.map((name) => [name, FAKE])), SystemRoot: "C:\\Windows" }, platform: "win32", gitRoot: null });
    for (const name of names) expect(env[name]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(FAKE);
  });

  test("names match case-insensitively and keep the spelling they came with", () => {
    const env = childEnv("shell", { source: { systemroot: "C:\\Windows", temp: "C:\\T", lc_all: "C", Home: "/h" }, platform: "win32", gitRoot: null });
    expect(env.systemroot).toBe("C:\\Windows");
    expect(env.temp).toBe("C:\\T");
    expect(env.lc_all).toBe("C");
    expect(env.Home).toBe("/h");
  });

  test("names that merely look listed are dropped (prefix and suffix are not matches)", () => {
    const env = childEnv("shell", { source: { TEMPX: "1", XTEMP: "1", LC: "1", LCX_ALL: "1", HOMEWORK: "1", SystemRootX: "1", TZ_SECRET: "1" }, platform: "linux" });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  test("extra variables are added after the allowlist and win over the source", () => {
    const env = childEnv("shell", { source: { TZ: "UTC" }, platform: "linux", extra: { SUDO_ASKPASS: "/tmp/a/askpass.sh", TZ: "Asia/Kolkata" } });
    expect(env.SUDO_ASKPASS).toBe("/tmp/a/askpass.sh");
    expect(env.TZ).toBe("Asia/Kolkata");
  });

  test("pdf-worker gets the same minimal set as the shell core, with no Windows extras", () => {
    const env = childEnv("pdf-worker", { source: { ...WIN_SOURCE, COMSPEC: "C:\\Windows\\System32\\cmd.exe", APPDATA: "C:\\a" }, platform: "win32", gitRoot: GIT });
    expect(env.COMSPEC).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.AGNI_HOME).toBeUndefined();
  });

  test("shell: AGNI_* settings and unlisted variables never pass, including AGNI_TOKEN", () => {
    const env = childEnv("shell", { source: { AGNI_HOME: "/h", AGNI_TOKEN: FAKE, AGNI_PORT: "1", NPM_CONFIG_USERCONFIG: "/x" }, platform: "linux" });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  test("daemon: the server's own settings and provider keys pass, a stranger does not", () => {
    const names = providerKeyEnvNames();
    const source = {
      ...Object.fromEntries(names.map((name) => [name, FAKE])),
      AGNI_HOME: "/h", AGNI_PORT: "8787", AGNI_TOKEN: "t", GMAIL_USER: "o@example.com", GMAIL_APP_PASSWORD: "p",
      GROQ_MODEL: "m", OPENROUTER_BASE_URL: "https://x/v1", HTTPS_PROXY: "http://proxy:3128",
      PATH: "/usr/bin:/opt/tools", HOME: "/home/o", SSH_AUTH_SOCK: "/tmp/agent", AWS_SECRET_ACCESS_KEY: FAKE, RANDOM_THING: "x",
    };
    const env = childEnv("daemon", { source, platform: "linux" });
    for (const name of names) expect(env[name]).toBe(FAKE);
    expect(env).toMatchObject({ AGNI_HOME: "/h", AGNI_PORT: "8787", AGNI_TOKEN: "t", GMAIL_USER: "o@example.com", GMAIL_APP_PASSWORD: "p", GROQ_MODEL: "m", HTTPS_PROXY: "http://proxy:3128", HOME: "/home/o" });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM_THING).toBeUndefined();
  });

  test("daemon: the owner's PATH passes (the server launches the owner's MCP tools) but loses empty, '.', and relative entries", () => {
    const env = childEnv("daemon", { source: { PATH: "/usr/bin::.:bin:/opt/tools:./x" }, platform: "linux" });
    expect(env.PATH).toBe("/usr/bin:/opt/tools");
    const win = childEnv("daemon", { source: { Path: "C:\\Windows;.;;tools;D:\\bin" }, platform: "win32" });
    expect(win.PATH).toBe("C:\\Windows;D:\\bin");
  });

  test("does not change the environment it was given", () => {
    const source = { OPENROUTER_API_KEY: FAKE, PATH: "/bin" };
    childEnv("shell", { source, platform: "linux" });
    expect(source).toEqual({ OPENROUTER_API_KEY: FAKE, PATH: "/bin" });
  });
});
