/**
 * The shell allowlist contract (S2-07).
 *
 * The server does not parse shell. A command is "proven" only when it is exactly one simple command,
 * its program is on a short list, and every word is a plain literal: no quotes, `$`, backticks,
 * patterns, braces, `~`, `=`, redirects or separators. What a proven command touches is its literal
 * path arguments, resolved against the folder the server chose to run it in. Anything else is
 * "unresolved": no file name is read out of it, and a run that holds a refusal puts it to the owner
 * every time (policy/engine.ts) instead of guessing what it reaches.
 *
 * An operand is unresolved too, and the command with it, when it has a `..` segment (the shell opens
 * `link/../x` through the link, so the words do not say which file) or when any part of it that exists is a
 * symbolic link or junction (the file is then somewhere the words do not name). Only the parts below the
 * folder the server chose are looked at: that folder is the server's own. The same goes for a bare drive
 * word (`C:`, the folder that drive is in) and for a `cp` or `mv` whose last operand is an existing folder
 * (the file it writes is inside the folder, under a name the words do not give).
 *
 * There are no wrappers (`sudo`, `env`, `timeout`, `nice`, `xargs`, ...) and no option that takes a
 * folder (`-C`, `-D`, `-t`, `--directory`): the lists below name every option each program may carry,
 * and a word that is not on them leaves the command unresolved. Adding a program or an option is a
 * line in `PROGRAMS`, never a new rule in a parser.
 *
 * For Sprint 7: unattended (sandboxed) shell is off in any run that holds a refusal. The sandbox
 * profile, not this module, is the boundary around what a command can reach.
 */
import { lstatSync, statSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { Operation } from "./types";

export type ShellProof =
  | {
      proven: true;
      program: string;
      operation: Operation;
      /** Absolute path of every literal path argument, `C:\...` style on Windows. No `..` segment, and no link in any part that exists. */
      paths: string[];
    }
  | { proven: false; why: string };

interface ProgramSpec {
  operation: Operation;
  /** Every short option the program may carry, as letters. A fused cluster (`-rf`) is read letter by letter. */
  flags: string;
  /** Options that take a whole number, as letters (`head -n 5`). */
  numeric?: string;
  /** `-5` stands for `-n 5`. */
  countFlag?: boolean;
  /** Are the other words files? False for a program whose words are text or nothing. */
  paths: boolean;
  /** Free of a card in a clean run although its operation is not `read`: it prints its words and touches no file (`echo`). */
  freeText?: true;
}

/**
 * The programs a proven command may be. The read-only ones are the programs `isReadOnlyCommand` (tools/bash.ts) frees: it
 * takes its program list from here (`READ_ONLY_PROGRAMS`) and frees only what `proveShell` proves, so the two cannot disagree.
 */
const PROGRAMS: Readonly<Record<string, ProgramSpec>> = {
  ls: { operation: "read", flags: "aAlhdFRtrSi1sp", paths: true },
  cat: { operation: "read", flags: "nbsAETv", paths: true },
  head: { operation: "read", flags: "qv", numeric: "nc", countFlag: true, paths: true },
  tail: { operation: "read", flags: "qv", numeric: "nc", countFlag: true, paths: true },
  wc: { operation: "read", flags: "lwcmL", paths: true },
  stat: { operation: "read", flags: "", paths: true },
  file: { operation: "read", flags: "bi", paths: true },
  du: { operation: "read", flags: "shacxk", paths: true },
  df: { operation: "read", flags: "hTak", paths: true },
  which: { operation: "read", flags: "a", paths: true },
  pwd: { operation: "read", flags: "LP", paths: false },
  uname: { operation: "read", flags: "asnrvmo", paths: false },
  whoami: { operation: "read", flags: "", paths: false },
  date: { operation: "read", flags: "u", paths: false },
  echo: { operation: "run", flags: "neE", paths: false, freeText: true },
  mkdir: { operation: "change", flags: "pv", paths: true },
  touch: { operation: "change", flags: "acm", paths: true },
  cp: { operation: "change", flags: "rRfinvpau", paths: true },
  mv: { operation: "change", flags: "finvu", paths: true },
  rm: { operation: "delete", flags: "rRfivd", paths: true },
};

/** The programs that run without a card in a clean run, when what they are given is proven (`isReadOnlyCommand`, tools/bash.ts). */
export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set(
  Object.entries(PROGRAMS).filter(([, spec]) => spec.operation === "read" || spec.freeText === true).map(([name]) => name),
);

/** A word of a proven command: letters, digits and `. _ , : @ + / -` only. */
const PLAIN_WORD = /^[A-Za-z0-9._,:@+/-]+$/;
/** `date +FORMAT`: a plus, then plain characters and `%`. The one pattern for it; the read-only gate asks `proveShell`. */
const DATE_FORMAT = /^\+[A-Za-z0-9%._,:@+/-]*$/;
const WHOLE_NUMBER = /^\d+$/;
const LONG_PATH_PREFIX = /^\/\/\?\/(?=[A-Za-z]:)/;

const unresolved = (why: string): ShellProof => ({ proven: false, why });

/**
 * Is `command` one allowlisted program with plain literal words, and if so what files does it name?
 * `cwd` is the absolute folder the server will run it in (the caller chose it, never the model).
 * `absoluteOnly` is for a command that may run somewhere else (`run_privileged` under the OS authorization runs in the
 * server's own folder): a relative operand does not say which file it is, so it is unresolved.
 */
export function proveShell(command: string, cwd: string, platform: NodeJS.Platform = process.platform, options: { absoluteOnly?: boolean } = {}): ShellProof {
  const words = command.trim().split(/[ \t]+/);
  const program = words[0] ?? "";
  const spec = Object.hasOwn(PROGRAMS, program) ? PROGRAMS[program] : undefined;
  if (!spec) return unresolved("the program is not on the allowlist, or the line is more than one plain command");
  const rest = words.slice(1);

  if (program === "date") {
    // `date` can set the clock: only the bare command, `-u`, and one `+FORMAT` word are proven.
    const formats = rest.filter((word) => word !== "-u");
    return formats.length <= 1 && formats.every((word) => DATE_FORMAT.test(word))
      ? { proven: true, program, operation: spec.operation, paths: [] }
      : unresolved("`date` with more than a format");
  }
  // `?` is a pattern character, with one exception: the Windows long-path prefix `//?/C:/`. A pattern that
  // needs a folder named `C:` under a one-letter mount can match nothing (Windows has no such name), and a
  // pattern that matches nothing reaches the shell's command line as it was typed.
  const literal = (word: string): string => (platform === "win32" ? word.replace(LONG_PATH_PREFIX, "//") : word);
  if (!rest.every((word) => PLAIN_WORD.test(literal(word)))) return unresolved("a word that is not a plain literal");

  const operands: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as string;
    if (optionsEnded || !word.startsWith("-")) {
      operands.push(word);
      continue;
    }
    if (word === "--") { optionsEnded = true; continue; }
    if (spec.countFlag && /^-\d+$/.test(word)) continue;
    if (!/^-[A-Za-z0-9]+$/.test(word)) return unresolved("an option the allowlist does not name");
    for (let at = 1; at < word.length; at += 1) {
      const letter = word[at] as string;
      if (spec.numeric?.includes(letter)) {
        const fused = word.slice(at + 1);
        if (fused !== "" ? !WHOLE_NUMBER.test(fused) : !WHOLE_NUMBER.test(rest[(index += 1)] ?? "")) return unresolved("an option value that is not a number");
        break;
      }
      if (!spec.flags.includes(letter)) return unresolved("an option the allowlist does not name");
    }
  }

  const paths: string[] = [];
  if (spec.paths) {
    for (const operand of operands) {
      const host = hostPathOf(operand, platform);
      if (host === null) return unresolved("a path the server cannot place on this computer");
      if (host.split(/[\\/]/).includes("..")) return unresolved("an operand with a `..` segment");
      if (options.absoluteOnly && !isAbsolute(host)) return unresolved("a relative operand, for a command that does not run in the folder the server chose");
      const absolute = resolve(cwd, host);
      if (crossesLink(absolute, cwd)) return unresolved("an operand that goes through a link");
      paths.push(absolute);
    }
    // `cp a dir` and `mv a dir` write `dir/a`: when the last operand is a folder, the file changed is not one of the words.
    if ((program === "cp" || program === "mv") && paths.length > 1 && isFolder(paths[paths.length - 1] as string)) return unresolved("a destination that is a folder");
  }
  return { proven: true, program, operation: spec.operation, paths };
}

/**
 * The one place a Git Bash style path becomes a Windows one, so a refusal made on `C:\x\q1` is the
 * same file as `/c/x/q1`, `/cygdrive/c/x/q1`, `/mnt/c/x/q1` and `//?/C:/x/q1`. On Windows any other
 * path that starts with `/` (`/tmp/x`, `//server/share`, `//./C:/x`) has no place the server can
 * name, and so does a word that Windows reads another way (`C:x`, `file:stream`, `name.`): null.
 * Elsewhere a path is what it says.
 */
export function hostPathOf(word: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return word;
  const long = /^\/\/\?\/([A-Za-z]):(?:\/(.*))?$/.exec(word);
  const mount = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?:\/(.*))?$/.exec(word);
  const drive = long ?? mount;
  if (drive) return windowsPath(`${(drive[1] as string).toUpperCase()}:`, drive[2] ?? "");
  if (word.startsWith("/") || word.includes("\\")) return null;
  const withDrive = /^([A-Za-z]:)(?:\/(.*))?$/.exec(word);
  // A bare drive word (`C:`) is the folder that drive is currently in, which the words do not say.
  if (withDrive && withDrive[2] === undefined) return null;
  const body = withDrive ? (withDrive[2] ?? "") : word;
  if (!withDrive && /^[A-Za-z]:/.test(word)) return null;
  // A colon past the drive is a data stream; a name ending in a dot or space is another name to Windows.
  if (body.includes(":") || body.split("/").some((part) => part !== "." && part !== ".." && /[. ]$/.test(part))) return null;
  return word;
}

function windowsPath(drive: string, rest: string): string | null {
  if (rest.includes(":") || rest.split("/").some((part) => part !== "." && part !== ".." && /[. ]$/.test(part))) return null;
  return `${drive}\\${rest.replaceAll("/", "\\")}`;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is any part of `absolute` that exists a symbolic link or junction? Each existing component is `lstat`ed, from just
 * below `cwd` (the server's own folder is not held against the operand) or from the root for a path outside it.
 * A component that cannot be read counts as a link: what cannot be seen is not proven.
 */
function crossesLink(absolute: string, cwd: string): boolean {
  const below = relative(cwd, absolute);
  const inside = below === "" || (below !== ".." && !below.startsWith(`..${sep}`) && parse(below).root === "");
  let current = inside ? cwd : parse(absolute).root;
  const parts = (inside ? below : absolute.slice(current.length)).split(sep).filter((part) => part !== "");
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ENOTDIR";
    }
  }
  return false;
}
