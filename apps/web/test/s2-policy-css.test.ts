import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom lays nothing out, so this reads the stylesheet: on a phone every new control of the policy
// core is a 44px target, the header controls shrink to fit 375px, and no colour is hard-coded. What
// they look like is checked in the running app at 375px.

const styles = join(import.meta.dirname, "../src/styles");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(join(styles, "s2-policy.css"), "utf8"));

/** The bodies of every `@media (<query>) { ... }` block, braces balanced, joined. */
function mediaBlock(source: string, query: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const start = source.indexOf(`@media (${query})`, from);
    if (start < 0) return out;
    const open = source.indexOf("{", start);
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}" && --depth === 0) break;
    }
    out += source.slice(open + 1, i);
    from = i;
  }
}

function declarations(source: string, selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").some((part) => part.trim() === selector)) continue;
    for (const d of m[2]!.split(";")) {
      const [name, ...value] = d.split(":");
      if (name?.trim() && value.length) merged[name.trim()] = value.join(":").trim();
    }
  }
  return merged;
}

const TOUCH = /^(44px|var\(--touch-target\))$/;
const phone = mediaBlock(css, "max-width: 720px");

describe("the policy controls on a phone", () => {
  it.each([
    [".policy-pause", "width"],
    [".policy-pause", "height"],
    [".spend-chip", "min-height"],
    [".spend-chip", "min-width"],
    [".approval-card .btn", "min-height"],
    [".approval-full-dialog .btn", "min-height"],
    [".budget-stop-card .btn", "min-height"],
    [".pause-banner .btn", "min-height"],
    [".composer-off-bar .btn", "min-height"],
    [".bot-power .btn", "min-height"],
    [".spending-actions .btn", "min-height"],
    [".spending-input .text-input", "min-height"],
    [".bot-power", "min-height"],
  ])("%s has a 44px %s", (selector, property) => {
    expect(declarations(phone, selector)[property]).toMatch(TOUCH);
  });

  it("the pause button is the icon alone, and the spend chip drops its 'Today' lead, so the header fits 375px", () => {
    expect(declarations(phone, ".policy-pause-text").display).toBe("none");
    expect(declarations(phone, ".spend-chip-lead").display).toBe("none");
    expect(declarations(phone, ".spend-chip-body")["flex-direction"]).toBe("column");
    expect(declarations(phone, ".thread-header .agent-pill")["max-width"]).toBe("110px");
  });

  it("the money field is 16px, so a phone does not zoom on focus", () => {
    expect(declarations(phone, ".spending-input .text-input")["font-size"]).toBe("16px");
  });
});

describe("colour comes from the tokens", () => {
  it("has no hex or rgb colour of its own", () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []).toEqual([]);
  });
});
