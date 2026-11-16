/**
 * INV-09: property tests for the three small predicates every gate leans on
 * (S2-15; track-c C5.4 item 9, plus the vectors from bug.md C2 and H1):
 *
 *   isOutsideScratch  (tools/write-file.ts)  which side of the scratch tree a path is on
 *   isReadOnlyCommand (tools/bash.ts)        when a shell command may run without a card
 *   isPrivateAddress  (tools/fetch-url.ts)   which addresses a fetch must never reach
 *
 * Each property is checked over a seeded pseudo-random sample (the seed is
 * printed in the failure message), against an oracle written independently of
 * the code under test: the sample is built so the right answer is known by
 * construction.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isReadOnlyCommand } from "../../src/tools/bash";
import { isPrivateAddress } from "../../src/tools/fetch-url";
import { isOutsideScratch } from "../../src/tools/write-file";

const SEED = 0x5eed2024;

/** mulberry32: small, fast, and the same sequence on every machine. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
const between = (next: () => number, low: number, high: number): number => low + Math.floor(next() * (high - low + 1));

// ---------------------------------------------------------------------------
// isOutsideScratch
// ---------------------------------------------------------------------------

/** The sampled tests touch the file system on every call; a loaded machine needs more than Bun's 5 s. */
const SAMPLED_TIMEOUT_MS = 30_000;

describe("INV-09 isOutsideScratch", () => {
  let root = "";
  let scratch = "";
  let outside = "";
  let savedScratch: string | undefined;
  let linkWorks = false;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agni-inv-scratch-"));
    scratch = join(root, "scratch");
    outside = join(root, "elsewhere");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(`${scratch}-evil`, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    savedScratch = process.env.AGNI_SCRATCH_DIR;
    process.env.AGNI_SCRATCH_DIR = scratch;
    try {
      // A junction needs no privilege on Windows and is a link everywhere else.
      symlinkSync(outside, join(scratch, "escape"), "junction");
      linkWorks = true;
    } catch {
      linkWorks = false;
    }
  });
  afterAll(() => {
    if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
    else process.env.AGNI_SCRATCH_DIR = savedScratch;
    rmSync(root, { recursive: true, force: true });
  });

  const segment = (next: () => number): string => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_-";
    let word = "";
    for (let index = between(next, 1, 8); index > 0; index -= 1) word += pick(next, [...alphabet]);
    // A bare "scratch" segment could climb out and walk back in; keep the sample unambiguous.
    return word === "scratch" ? "scratch1" : word;
  };

  test("a path built under the scratch tree is inside, absolute or relative (seed 0x5eed2024)", () => {
    const next = rng(SEED);
    const wrong: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const parts = Array.from({ length: between(next, 1, 5) }, () => segment(next));
      const absolute = join(scratch, ...parts);
      const relative = parts.join("/");
      if (isOutsideScratch(absolute, scratch)) wrong.push(absolute);
      if (isOutsideScratch(relative, scratch)) wrong.push(relative);
    }
    expect(wrong.slice(0, 5), "paths under scratch reported as outside").toEqual([]);
  }, SAMPLED_TIMEOUT_MS);

  test("any path that climbs out with .. is outside, however deep it goes after (seed 0x5eed2024)", () => {
    const next = rng(SEED + 1);
    const wrong: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const parts = Array.from({ length: between(next, 0, 4) }, () => segment(next));
      const climbs = "../".repeat(between(next, 1, 4));
      const path = `${climbs}${parts.join("/")}`;
      if (!isOutsideScratch(path, scratch)) wrong.push(path);
      const mixed = `${parts.join("/")}/${climbs}`.replaceAll("//", "/");
      // Going down first and climbing exactly back is inside; one climb more is outside.
      const oneTooMany = `${parts.join("/")}${parts.length ? "/" : ""}${"../".repeat(parts.length + 1)}x`;
      if (!isOutsideScratch(oneTooMany, scratch)) wrong.push(oneTooMany);
      void mixed;
    }
    expect(wrong.slice(0, 5), "paths that leave scratch reported as inside").toEqual([]);
  }, SAMPLED_TIMEOUT_MS);

  test("a sibling directory that only shares the scratch name as a prefix is outside", () => {
    expect(isOutsideScratch(`${scratch}-evil`, scratch)).toBe(true);
    expect(isOutsideScratch(join(`${scratch}-evil`, "x.txt"), scratch)).toBe(true);
    expect(isOutsideScratch(`../${basename(scratch)}-evil/x.txt`, scratch)).toBe(true);
  });

  test("absolute paths elsewhere, the temp root, the home directory and the system are outside", () => {
    const places = [outside, join(outside, "secret.txt"), tmpdir(), root, process.env.HOME ?? process.env.USERPROFILE ?? root];
    if (process.platform === "win32") places.push("C:\\Windows\\System32\\drivers\\etc\\hosts", "\\\\server\\share\\x", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\C:\\Windows");
    else places.push("/etc/passwd", "/", "/proc/self/environ");
    for (const place of places) expect(isOutsideScratch(place, scratch), `${place} counted as scratch`).toBe(true);
  });

  test("an empty or blank path is outside (it names nothing safe)", () => {
    for (const blank of ["", " ", "\t", "  \n "]) expect(isOutsideScratch(blank, scratch), JSON.stringify(blank)).toBe(true);
  });

  test("a link inside scratch that points out of it is outside, for the link and everything under it", () => {
    if (!linkWorks) return; // no link support on this machine: nothing to prove
    expect(isOutsideScratch(join(scratch, "escape"), scratch)).toBe(true);
    expect(isOutsideScratch(join(scratch, "escape", "secret.txt"), scratch)).toBe(true);
    expect(isOutsideScratch("escape/secret.txt", scratch)).toBe(true);
    expect(isOutsideScratch("escape/not-yet-created/new.txt", scratch)).toBe(true);
  });

  test("Windows path forms that still land outside are outside (UNC, device, backslash climbs)", () => {
    if (process.platform !== "win32") return;
    const forms = [
      `${scratch}\\..\\elsewhere\\secret.txt`,
      `..\\elsewhere\\secret.txt`,
      `${scratch}\\..\\..`,
      "\\\\localhost\\c$\\Windows",
      "\\\\?\\UNC\\server\\share\\x",
    ];
    for (const form of forms) expect(isOutsideScratch(form, scratch), `${form} counted as scratch`).toBe(true);
  });

  test("the case of the path does not matter where the file system ignores it", () => {
    const upper = scratch.toUpperCase();
    // Windows folds case, so the same directory in capitals is still scratch; elsewhere "outside" is the safe answer.
    expect(isOutsideScratch(join(upper, "a.txt"), scratch)).toBe(process.platform !== "win32");
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyCommand
// ---------------------------------------------------------------------------

describe("INV-09 isReadOnlyCommand", () => {
  let root = "";
  let scratch = "";
  let savedScratch: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agni-inv-shell-"));
    scratch = join(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "notes.txt"), "notes");
    savedScratch = process.env.AGNI_SCRATCH_DIR;
    process.env.AGNI_SCRATCH_DIR = scratch;
  });
  afterAll(() => {
    if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
    else process.env.AGNI_SCRATCH_DIR = savedScratch;
    rmSync(root, { recursive: true, force: true });
  });

  /** An independent statement of "one plain read-only command": a short program list and plain words. */
  const ORACLE_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "date", "whoami", "uname", "which", "file", "stat", "du", "df"]);
  const PLAIN = /^(--?[A-Za-z0-9-]+|[A-Za-z0-9._,:@%+/-]+)$/;
  const oracleSaysPlain = (command: string): boolean => {
    const words = command.trim().split(/[ \t]+/);
    return ORACLE_PROGRAMS.has(words[0] ?? "") && words.slice(1).every((word) => PLAIN.test(word));
  };

  test("plain read-only commands on scratch files are accepted (the baseline that keeps quick questions card-free)", () => {
    for (const command of ["ls", "ls -la", "pwd", "cat notes.txt", "head -n 5 notes.txt", "wc -l notes.txt", "echo hello", "whoami", "stat notes.txt"]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  test("whatever is accepted is a plain read-only command: no accepted command carries a metacharacter or a program off the list (seed 0x5eed2024)", () => {
    const next = rng(SEED + 2);
    const programs = [...ORACLE_PROGRAMS, "rm", "mv", "cp", "touch", "mkdir", "tee", "sed", "awk", "find", "tar", "curl", "wget", "python", "python3", "node", "bun", "git", "sh", "bash", "env", "printenv", "xargs", "dd", "ln", "chmod", "kill", "nc", "ssh", "perl", "sudo", "truncate", "ls;rm", "LS", "l\\s"];
    const pieces = ["notes.txt", "-la", "-n", "5", "--all", ".", "..", "/", "~", "$HOME", "$(id)", "`id`", ";", "|", "&", "&&", "||", ">", ">>", "<", "*", "?", "{a,b}", "[a]", "'x'", "\"x\"", "\\n", "!", "#", "\n", "\r", "%", "=", "a=b", "x y"];
    const accepted: string[] = [];
    const wrong: string[] = [];
    for (let round = 0; round < 1500; round += 1) {
      const command = [pick(next, programs), ...Array.from({ length: between(next, 0, 4) }, () => pick(next, pieces))].join(pick(next, [" ", "  ", "\t"]));
      if (isReadOnlyCommand(command)) {
        accepted.push(command);
        if (!oracleSaysPlain(command)) wrong.push(command);
      }
    }
    expect(accepted.length, "the sample never produced an accepted command, so it proves nothing").toBeGreaterThan(20);
    expect(wrong.slice(0, 5), "accepted commands that are not plain read-only commands").toEqual([]);
  }, SAMPLED_TIMEOUT_MS);

  test("a metacharacter anywhere in a command, on its own or glued to a word, makes it need a card (seed 0x5eed2024)", () => {
    const next = rng(SEED + 3);
    const meta = [";", "|", "&", "<", ">", "`", "$", "(", ")", "{", "}", "[", "]", "*", "?", "~", "'", "\"", "\\", "!", "#", "\n", "\r"];
    const bases = ["cat notes.txt", "ls -la", "echo hello", "head -n 5 notes.txt", "wc -l notes.txt", "pwd"];
    const wrong: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const base = pick(next, bases);
      const mark = pick(next, meta);
      // A line break at the very start or end is trimmed away before the shell sees a word; inside a command it is a separator.
      const edge = mark === "\n" || mark === "\r";
      const at = edge ? between(next, 1, base.length - 1) : between(next, 0, base.length);
      const glued = `${base.slice(0, at)}${mark}${base.slice(at)}`;
      const spaced = `${base} ${mark} rm notes.txt`;
      for (const command of [glued, spaced]) if (isReadOnlyCommand(command)) wrong.push(JSON.stringify(command));
    }
    expect(wrong.slice(0, 5), "commands with a metacharacter accepted").toEqual([]);
  }, SAMPLED_TIMEOUT_MS);

  test("a program that changes things is never accepted, however plain its arguments", () => {
    const writers = ["rm", "mv", "cp", "touch", "mkdir", "rmdir", "tee", "sed", "awk", "find", "tar", "curl", "wget", "python", "python3", "node", "bun", "git", "sh", "bash", "env", "printenv", "xargs", "dd", "ln", "chmod", "chown", "kill", "nc", "ssh", "perl", "ruby", "sudo", "truncate", "sort", "tr", "cut", "make", "npm", "pip"];
    for (const program of writers) {
      for (const tail of ["", " notes.txt", " -f notes.txt", " -rf notes.txt", " --help"]) {
        expect(isReadOnlyCommand(`${program}${tail}`), `${program}${tail}`).toBe(false);
      }
    }
  });

  test("the bug.md C2 vectors all need a card", () => {
    const vectors = [
      "rm -rf $HOME",
      "rm -rf ./*",
      "rm -r -f x",
      "find ~ -delete",
      "truncate -s0 ~/.agni/agni.db",
      "mv ~/.agni /tmp/x",
      "echo k >> ~/.ssh/authorized_keys",
      "dd of=/dev/disk0 if=/dev/zero",
      "curl x | python3",
      "git -C . push",
      "s''udo id",
      "perl -e 'unlink glob q(*)'",
    ];
    for (const vector of vectors) expect(isReadOnlyCommand(vector), vector).toBe(false);
  });

  test("an operand that really lives outside scratch needs a card: absolute, climbing, a drive, or through a link", () => {
    const operands = ["/etc/passwd", "/", "..", "../notes.txt", "a/../../x", "C:/Windows/win.ini", "~", "..\\x", "\\\\server\\share\\x", "notes.txt/../../x"];
    for (const operand of operands) for (const program of ["cat", "ls", "head", "stat", "wc", "du"]) {
      expect(isReadOnlyCommand(`${program} ${operand}`), `${program} ${operand}`).toBe(false);
    }
  });

  test("the working directory is part of the answer: the same plain command outside scratch needs a card", () => {
    expect(isReadOnlyCommand("ls", scratch)).toBe(true);
    expect(isReadOnlyCommand("ls", root)).toBe(false);
    expect(isReadOnlyCommand("ls", tmpdir())).toBe(false);
    expect(isReadOnlyCommand("cat notes.txt", join(root, "does-not-exist"))).toBe(false);
  });

  test("look-alike and invisible characters in the program or an operand need a card", () => {
    for (const command of ["ｌｓ", "ls\u00a0notes.txt", "cat\u200bnotes.txt", "cat n\u202etxt.sl", "cat notes.txt\u0000", "cat notes\u0301.txt", "ls\u2028rm x"]) {
      expect(isReadOnlyCommand(command), JSON.stringify(command)).toBe(false);
    }
  });

  // beyond bug.md C2: no Sprint 2 task owns it yet; S2-14 touches bash.ts and could take it
  test("flags that make a read-only program change the machine need a card (beyond bug.md C2)", () => {
    // `date -s` sets the system clock; the program is on the list, the flag is plain, the operand is a plain word.
    for (const command of ["date -s 12:00", "date -u -s 12:00", "date --set 12:00"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isPrivateAddress
// ---------------------------------------------------------------------------

describe("INV-09 isPrivateAddress", () => {
  /** Reserved IPv4 blocks as [first, last] 32-bit bounds, written down from the registries, not from the code. */
  const RESERVED: Array<[number, number]> = [
    [0x00000000, 0x00ffffff], // 0.0.0.0/8
    [0x0a000000, 0x0affffff], // 10/8
    [0x64400000, 0x647fffff], // 100.64/10
    [0x7f000000, 0x7fffffff], // 127/8
    [0xa9fe0000, 0xa9feffff], // 169.254/16
    [0xac100000, 0xac1fffff], // 172.16/12
    [0xc0000000, 0xc00000ff], // 192.0.0/24
    [0xc0a80000, 0xc0a8ffff], // 192.168/16
    [0xc6120000, 0xc613ffff], // 198.18/15
    [0xe0000000, 0xffffffff], // 224/4 multicast and 240/4 reserved
  ];
  const isReserved = (value: number): boolean => RESERVED.some(([low, high]) => value >= low && value <= high);
  const dotted = (value: number): string => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  const hextets = (value: number): string => `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  const randomV4 = (next: () => number): number => Math.floor(next() * 4294967296) >>> 0;
  const inBlock = (next: () => number, [low, high]: [number, number]): number => low + Math.floor(next() * (high - low + 1));

  test("every address in a reserved IPv4 block is private, and every other address is public (seed 0x5eed2024)", () => {
    const next = rng(SEED + 4);
    const wrong: string[] = [];
    for (let round = 0; round < 3000; round += 1) {
      const value = round % 2 === 0 ? randomV4(next) : inBlock(next, pick(next, RESERVED));
      // TEST-NET documentation ranges are not in the registry list above and not private to the filter either: stay clear of them.
      if (((value >>> 8) === 0xc00002) || ((value >>> 8) === 0xc63364) || ((value >>> 8) === 0xcb0071)) continue;
      const got = isPrivateAddress(dotted(value));
      if (got !== isReserved(value)) wrong.push(`${dotted(value)} -> ${got}`);
    }
    expect(wrong.slice(0, 5), "IPv4 addresses classed wrongly").toEqual([]);
  });

  test("block edges: the first and last address of each reserved block are private, the neighbours outside are public", () => {
    for (const [low, high] of RESERVED) {
      expect(isPrivateAddress(dotted(low)), dotted(low)).toBe(true);
      expect(isPrivateAddress(dotted(high)), dotted(high)).toBe(true);
      if (low > 0 && !isReserved(low - 1)) expect(isPrivateAddress(dotted(low - 1)), `below ${dotted(low)}`).toBe(false);
      if (high < 0xffffffff && !isReserved(high + 1)) expect(isPrivateAddress(dotted(high + 1)), `above ${dotted(high)}`).toBe(false);
    }
  });

  test("an IPv4 address wrapped in IPv6 (mapped, compatible, NAT64) keeps the IPv4 answer (bug.md H1; seed 0x5eed2024)", () => {
    const next = rng(SEED + 5);
    const wrong: string[] = [];
    for (let round = 0; round < 1500; round += 1) {
      const value = round % 2 === 0 ? randomV4(next) : inBlock(next, pick(next, RESERVED));
      if (((value >>> 8) === 0xc00002) || ((value >>> 8) === 0xc63364) || ((value >>> 8) === 0xcb0071)) continue;
      const want = isReserved(value);
      const forms = [
        `::ffff:${dotted(value)}`,
        `::ffff:${hextets(value)}`,
        `[::ffff:${hextets(value)}]`,
        `64:ff9b::${dotted(value)}`,
        `64:ff9b::${hextets(value)}`,
        `::${hextets(value)}`,
        `0:0:0:0:0:ffff:${hextets(value)}`,
      ];
      for (const form of forms) {
        // The IPv4-compatible form of a low address collapses into "::1"-style loopback and the unspecified address, which are private by their own rule.
        if (form.startsWith("::") && !form.startsWith("::ffff") && (value >>> 0) < 0x10000) continue;
        if (isPrivateAddress(form) !== want) wrong.push(`${form} (v4 ${dotted(value)}) -> ${!want}`);
      }
    }
    expect(wrong.slice(0, 5), "wrapped IPv4 addresses classed wrongly").toEqual([]);
  });

  test("the bug.md H1 vectors are all private", () => {
    for (const address of ["[::ffff:7f00:1]", "::ffff:169.254.169.254", "[::ffff:169.254.169.254]", "64:ff9b::7f00:1", "[64:ff9b::7f00:1]", "::7f00:1", "[::7f00:1]", "fec0::1", "[fec0::1]"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  test("IPv6 loopback, unspecified, link-local, unique-local, site-local and multicast are private (seed 0x5eed2024)", () => {
    const next = rng(SEED + 6);
    const group = (): string => between(next, 0, 0xffff).toString(16);
    const wrong: string[] = [];
    for (let round = 0; round < 400; round += 1) {
      const tail = `${group()}:${group()}:${group()}:${group()}:${group()}:${group()}`;
      const addresses = [
        `fe${pick(next, ["8", "9", "a", "b"])}${between(next, 0, 15).toString(16)}:${tail}`, // fe80::/10
        `f${pick(next, ["c", "d"])}${between(next, 0, 255).toString(16).padStart(2, "0")}:${tail}`, // fc00::/7
        `fe${pick(next, ["c", "d", "e", "f"])}${between(next, 0, 15).toString(16)}:${tail}`, // fec0::/10
        `ff${between(next, 0, 255).toString(16).padStart(2, "0")}:${tail}`, // ff00::/8
        `fe80::${group()}%eth0`,
      ];
      for (const address of addresses) if (!isPrivateAddress(address)) wrong.push(address);
    }
    for (const address of ["::", "::1", "[::1]", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001"]) if (!isPrivateAddress(address)) wrong.push(address);
    expect(wrong.slice(0, 5), "private IPv6 addresses reported public").toEqual([]);
  });

  test("public IPv6 addresses are public", () => {
    for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "[2606:4700::1111]"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  test("anything that is not a plain address counts as private: names, numbers in other bases, short and long forms, garbage (seed 0x5eed2024)", () => {
    const fixed = ["", " ", "localhost", "example.com", "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4/8", "1.2.3.4:80", "::g", ":::", "1::2::3", "12345::", "8.8.8.8 ", " 8.8.8.8", "8.8.8.8\n", "８.８.８.８"];
    const wrong = fixed.filter((value) => !isPrivateAddress(value));
    const next = rng(SEED + 7);
    const alphabet = [..."abcdefghijklmnopqrstuvwxyz0123456789.:/-_ %[]"];
    for (let round = 0; round < 500; round += 1) {
      const text = Array.from({ length: between(next, 1, 14) }, () => pick(next, alphabet)).join("");
      // Leave out the rare accidental valid address; everything else must read as private.
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(text) && text.split(".").every((part) => Number(part) < 256 && String(Number(part)) === part)) continue;
      if (!isPrivateAddress(text)) wrong.push(JSON.stringify(text));
    }
    expect(wrong.slice(0, 5), "non-addresses treated as safe to fetch").toEqual([]);
  });

  // beyond bug.md H1 (fetch-url.ts). 64:ff9b:1::/48 is the local-use NAT64 prefix (RFC 8215): not globally reachable, so never public.
  test("IPv6 forms that embed a private IPv4 address are private (beyond bug.md H1: 6to4 and IPv4-translated)", () => {
    const embedded = [
      "2002:7f00:0001::", // 6to4 of 127.0.0.1
      "2002:0a00:0001::1", // 6to4 of 10.0.0.1
      "2002:c0a8:0101::1", // 6to4 of 192.168.1.1
      "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
      "::ffff:0:7f00:1", // IPv4-translated (SIIT) of 127.0.0.1
      "64:ff9b:1::7f00:1", // local-use NAT64 of 127.0.0.1
    ];
    const reportedPublic = embedded.filter((address) => !isPrivateAddress(address));
    expect(reportedPublic, "forms that carry a private IPv4 address but pass as public").toEqual([]);
  });
});
