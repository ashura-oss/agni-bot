/**
 * Reading a shell line for the policy engine (S2-07).
 *
 * The answers feed denials ("the owner said no to this file") and the card's
 * wording, so they over-approximate: a word is a candidate resource unless it
 * is provably not one, and a line the server cannot follow to file names says
 * so (`unresolved`) instead of pretending it names nothing. This is not a
 * shell parser; it is the smallest scanner that cannot be talked into
 * dropping a word, and it needs no network, model, or file system.
 */

export interface Redirect {
  kind: "in" | "out";
  target: string;
}

/** One simple command: `A=1 prog arg > file`. */
export interface ShellSegment {
  /** Leading `NAME=value` words. */
  assignments: string[];
  program: string | null;
  args: string[];
  redirects: Redirect[];
}

export interface ShellScan {
  segments: ShellSegment[];
  /** Every word that could name a file or folder, in every spelling the scanner can see (quotes removed, escapes kept or dropped, the part after `=`, the pieces of a quoted string). Nothing is dropped. */
  words: string[];
  /** Why the line cannot be resolved to file names, one phrase each; empty for a plain line. */
  unresolved: string[];
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const QUOTED = "\u0000";
const GLOB = /[*?[]/;
const BRACE_LIST = /\{[^{}]*(,|\.\.)[^{}]*\}/;
const METACHARS = /[\s;|&()<>`$"'\\]/;

/** Programs that run something the line does not spell out. */
const RUNS_OTHER_CODE = new Set([
  "eval", "source", ".", "alias", "xargs", "cd", "pushd", "popd",
  "sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "ash", "busybox", "cmd", "powershell", "pwsh",
  "awk", "gawk", "mawk", "nawk",
]);
/** Interpreters that take their program on the command line. */
const TAKES_INLINE_CODE = new Set(["python", "python2", "python3", "py", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "osascript"]);
const INLINE_FLAGS = /^(-c|-e|-E|-r|-p|--eval|--print|-command|-encodedcommand)$/i;
/** Programs whose next word is the command they run. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "setsid", "exec", "xargs", "watch"]);
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

export function programName(word: string | null): string {
  if (!word) return "";
  const last = word.split(/[\\/]/).pop() ?? "";
  return last.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

const emptySegment = (): ShellSegment => ({ assignments: [], program: null, args: [], redirects: [] });
const isEmpty = (seg: ShellSegment): boolean => seg.program === null && seg.args.length === 0 && seg.assignments.length === 0 && seg.redirects.length === 0;

export function scanShell(command: string): ShellScan {
  const segments: ShellSegment[] = [];
  const unresolved = new Set<string>();
  const words = new Set<string>();
  let seg = emptySegment();
  let cooked = "";
  let raw = "";
  let shape = "";
  let started = false;
  let quote: string | null = null;
  let redirect: { kind: "in" | "out"; dup: boolean } | null = null;

  const addWord = (base: string): void => {
    const add = (value: string): void => { if (value) words.add(value); };
    const spellings = (text: string): void => {
      add(text);
      for (let at = text.indexOf("="); at >= 0; at = text.indexOf("=", at + 1)) add(text.slice(at + 1));
      if (/^-[^-]/.test(text) && text.length > 2) add(text.slice(2));
    };
    spellings(base);
    if (METACHARS.test(base)) for (const part of base.split(/[\s;|&()<>`$"'\\]+/)) spellings(part);
  };

  const endWord = (): void => {
    if (!started) return;
    const word = { cooked, raw, shape };
    cooked = ""; raw = ""; shape = ""; started = false;
    if (redirect?.dup && /^(\d+|-)$/.test(word.cooked)) { redirect = null; return; }
    for (const spelling of new Set([word.cooked, word.raw])) addWord(spelling);
    if (GLOB.test(word.shape)) unresolved.add("a pattern with * ? or [ ]");
    if (BRACE_LIST.test(word.shape)) unresolved.add("a brace list");
    if (word.shape.startsWith("~") && word.shape.length > 1 && word.shape[1] !== "/") unresolved.add("another user's home folder");
    if (redirect) {
      seg.redirects.push({ kind: redirect.kind, target: word.cooked });
      redirect = null;
    } else if (seg.program === null && seg.args.length === 0 && ASSIGNMENT.test(word.cooked) && !word.shape.slice(0, word.cooked.indexOf("=")).includes(QUOTED)) {
      seg.assignments.push(word.cooked);
    } else if (seg.program === null) {
      seg.program = word.cooked;
    } else {
      seg.args.push(word.cooked);
    }
  };
  const endSegment = (): void => {
    endWord();
    if (!isEmpty(seg)) segments.push(seg);
    seg = emptySegment();
  };
  const append = (cookedChar: string, rawChar: string, shapeChar: string): void => {
    cooked += cookedChar; raw += rawChar; shape += shapeChar; started = true;
  };
  /** `$` that starts an expansion, in double quotes or bare. */
  const dollar = (next: string | undefined, bare: boolean): void => {
    if (next === undefined) return;
    if (next === "(") unresolved.add("a command substitution");
    else if (next === "{" || /[A-Za-z_0-9@*#?!$-]/.test(next)) unresolved.add("a variable");
    else if (bare && (next === "'" || next === "\"")) unresolved.add("$-quoting");
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null; else append(c, c, QUOTED);
      continue;
    }
    if (quote === "\"") {
      if (c === "\"") quote = null;
      else if (c === "\\" && next !== undefined && "$`\"\\\n".includes(next)) { i += 1; if (next !== "\n") append(next, c + next, QUOTED); }
      else {
        if (c === "`") unresolved.add("backticks");
        if (c === "$") dollar(next, false);
        append(c, c, QUOTED);
      }
      continue;
    }
    switch (c) {
      case "'": case "\"": quote = c; started = true; break;
      case "\\":
        if (next === undefined) append(c, c, QUOTED);
        else { i += 1; if (next !== "\n") append(next, c + next, QUOTED); }
        break;
      case "$": dollar(next, true); append(c, c, c); break;
      case "`": unresolved.add("backticks"); endSegment(); break;
      case " ": case "\t": case "\r": endWord(); break;
      case "\n": case ";": case "(": case ")": case "|": endSegment(); break;
      case "&":
        if (next === ">") {
          endWord(); i += 1;
          if (command[i + 1] === ">") i += 1;
          redirect = { kind: "out", dup: false };
        } else {
          endSegment();
        }
        break;
      case ">": case "<": {
        // `2>`: the number is a descriptor, not a word.
        if (started && /^\d+$/.test(cooked) && raw === cooked) { cooked = ""; raw = ""; shape = ""; started = false; } else endWord();
        const kind: "in" | "out" = c === ">" || next === ">" ? "out" : "in";
        let dup = false;
        if (next === "(") unresolved.add("a process substitution");
        if (c === "<" && next === "<") {
          unresolved.add("a here-document");
          i += command[i + 2] === "<" || command[i + 2] === "-" ? 2 : 1;
        } else if (c === ">" && (next === ">" || next === "|")) {
          i += 1;
        } else if (next === "&") {
          dup = true; i += 1;
        } else if (c === "<" && next === ">") {
          i += 1;
        }
        redirect = next === "(" ? null : { kind, dup };
        break;
      }
      default: append(c, c, c);
    }
  }
  if (quote) unresolved.add("an unclosed quote");
  endSegment();

  for (const segment of segments) {
    const chain = chainOf(segment);
    for (const name of chain.names) {
      if (RUNS_OTHER_CODE.has(name)) unresolved.add(`\`${name}\``);
    }
    if (chain.names.some((name) => TAKES_INLINE_CODE.has(name)) && chain.rest.some((arg) => INLINE_FLAGS.test(arg))) unresolved.add("code given on the command line");
    if (chain.names.includes("find") && chain.rest.some((arg) => FIND_RUNS.has(arg) || arg === "-delete")) unresolved.add("`find` acting on what it finds");
  }
  return { segments, words: [...words], unresolved: [...unresolved] };
}

export interface ProgramChain {
  /** The program and every program it wraps (`sudo rm`: sudo, rm), as lower-case names. */
  names: string[];
  /** The word of the innermost program. */
  program: string | null;
  /** What follows the innermost program. */
  rest: string[];
  /** Words a wrapper took before the real program: options, assignments, durations. */
  skipped: string[];
}

/** Look through `sudo`, `env`, `time`, `xargs` and the like to the program that really runs. */
export function chainOf(segment: ShellSegment): ProgramChain {
  let program = segment.program;
  let rest = segment.args;
  const names: string[] = [];
  const skipped: string[] = [];
  for (let guard = 0; program !== null && guard < 8; guard += 1) {
    const name = programName(program);
    names.push(name);
    if (!WRAPPERS.has(name)) break;
    const at = rest.findIndex((word) => !word.startsWith("-") && !ASSIGNMENT.test(word) && !/^\d+(\.\d+)?[smhd]?$/.test(word));
    if (at < 0) break;
    skipped.push(...rest.slice(0, at));
    program = rest[at] as string;
    rest = rest.slice(at + 1);
  }
  // `find ... -exec rm {} \;` runs `rm`; `find ... -delete` deletes.
  if (names.includes("find")) {
    if (rest.includes("-delete")) names.push("rm");
    for (const [index, arg] of rest.entries()) if (FIND_RUNS.has(arg) && rest[index + 1]) names.push(programName(rest[index + 1] ?? null));
  }
  return { names, program, rest, skipped };
}
