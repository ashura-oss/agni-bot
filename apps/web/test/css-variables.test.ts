import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A `var(--name)` with no fallback, whose name nobody declares where the reader can see it, is invalid
// at computed-value time: the property silently falls back to its initial value (a transparent
// background, an inherited colour). This test scans every stylesheet for that.

const root = join(import.meta.dirname, "../src");
const stylesDir = join(root, "styles");

function walk(dir: string, accept: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, accept) : accept(path) ? [path] : [];
  });
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = walk(stylesDir, (file) => file.endsWith(".css")).map((file) => ({ file, text: stripComments(readFileSync(file, "utf8")) }));

/** Innermost `selector { body }` blocks, so rules inside @media still come out as rules. */
function rules(text: string): { selector: string; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

/** Names the app itself sets at runtime (appearance, agent theme, the sidebar width, a swatch): string literals in the sources. */
function runtimeNames(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(root, (path) => /\.(ts|tsx)$/.test(path))) {
    for (const m of readFileSync(file, "utf8").matchAll(/["'`](--[a-z][\w-]*)["'`]/g)) names.add(m[1]!);
  }
  return names;
}

/** Names declared where every screen can read them: on `:root` or on `.app`, the element the appearance system styles. */
function globalNames(): Set<string> {
  const names = new Set<string>(runtimeNames());
  for (const { text } of sheets) {
    for (const { selector, body } of rules(text)) {
      if (!selector.split(",").some((part) => /^(:root|\.app)$/.test(part.trim()))) continue;
      for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]!);
    }
  }
  return names;
}

describe("stylesheet custom properties", () => {
  it("reads no custom property, without a fallback, that is not declared globally or in its own stylesheet", () => {
    const declared = globalNames();
    const undefinedReads: string[] = [];
    for (const { file, text } of sheets) {
      // A name a screen declares on its own root (`.debug-view { --debug-ok }`) is fine for that file's rules.
      const local = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        if (!declared.has(m[1]!) && !local.has(m[1]!)) undefinedReads.push(`${m[1]} (${file.slice(stylesDir.length + 1)})`);
      }
    }
    expect([...new Set(undefinedReads)].sort()).toEqual([]);
  });

  it("maps the old names onto the design tokens", () => {
    const tokens = readFileSync(join(stylesDir, "tokens.css"), "utf8");
    const globalRule = rules(stripComments(tokens)).find((rule) => rule.selector.split(",").some((part) => part.trim() === ".app") && /--accent\s*:/.test(rule.body));
    expect(globalRule, "tokens.css needs a `:root, .app` rule that defines the old names").toBeDefined();
    const map = Object.fromEntries([...globalRule!.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
    expect(map).toMatchObject({
      "--accent": "var(--ember)",
      "--border": "var(--hairline)",
      "--text": "var(--ink)",
      "--text-dim": "var(--ink-secondary)",
      "--ink-primary": "var(--ink)",
    });
    // On :root too, so a page outside .app (a bare dialog under test) still resolves them.
    expect(globalRule!.selector.split(",").map((part) => part.trim())).toContain(":root");
  });
});
