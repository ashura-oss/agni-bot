import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom does not lay anything out, so this reads the stylesheets: the phone rules that make touch
// targets 44px and fields 16px have to exist, in the phone media block, with those values. What they
// look like is checked in the running app at 375px.

const styles = join(import.meta.dirname, "../src/styles");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (name: string) => strip(readFileSync(join(styles, name), "utf8"));

/** The body of the first `@media (<query>) { ... }` block, braces balanced. */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media (${query})`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  return "";
}

/** Declarations of every rule in `css` whose selector list contains `selector`, merged in order. */
function declarations(css: string, selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").some((part) => part.trim() === selector)) continue;
    for (const d of m[2]!.split(";")) {
      const [name, ...value] = d.split(":");
      if (name?.trim() && value.length) merged[name.trim()] = value.join(":").trim();
    }
  }
  return merged;
}

const TOUCH = /^(44px|var\(--touch-target\))$/;
const phone = mediaBlock(read("phone-touch.css"), "max-width: 720px");

describe("phone touch targets", () => {
  it.each([
    [".dashboard-task-check", "width"],
    [".dashboard-task-check", "height"],
    [".dashboard-task-title", "min-height"],
    [".task-action-menu > summary", "width"],
    [".task-action-menu > summary", "height"],
    [".sidebar-star", "width"],
    [".sidebar-star", "height"],
    [".segmented button", "min-height"],
    [".settings-overlay .btn", "min-height"],
  ])("%s has a 44px %s on a phone", (selector, property) => {
    expect(declarations(phone, selector)[property]).toMatch(TOUCH);
  });

  it("keeps the phone rules in one block that loads after the desktop overrides", () => {
    expect(phone).not.toBe("");
    const order = [...read("app.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1]);
    expect(order.indexOf("phone-touch.css")).toBeGreaterThan(order.indexOf("overrides-v3.css"));
  });
});

describe("phone fields", () => {
  it.each([".colour-control label", ".colour-control input[type=\"text\"]"])(
    "%s is at least 16px, so a phone does not zoom on focus",
    (selector) => {
      const size = declarations(phone, selector)["font-size"];
      expect(size, selector).toBeDefined();
      expect(Number.parseFloat(size!)).toBeGreaterThanOrEqual(16);
    },
  );
});

describe("phone colour control", () => {
  it("has a 44px picker and hex field", () => {
    expect(declarations(phone, ".colour-control input[type=\"color\"]")["min-height"]).toMatch(TOUCH);
    expect(declarations(phone, ".colour-control input[type=\"text\"]")["min-height"]).toMatch(TOUCH);
  });
});

describe("the new-task dialog on a narrow screen", () => {
  it("lets its grid columns and fields shrink, so a date field cannot push past the edge", () => {
    const composer = read("conversation.css");
    expect(declarations(composer, ".task-composer-fields")["grid-template-columns"]).toBe("minmax(0, 1fr) minmax(0, 1fr)");
    const inputs = declarations(composer, ".task-composer-fields input");
    expect(inputs["min-width"]).toBe("0");
    expect(inputs["width"]).toBe("100%");
  });

  it("stacks the fields in one column under 420px", () => {
    const narrow = mediaBlock(read("phone-touch.css"), "max-width: 420px");
    expect(declarations(narrow, ".task-composer-fields")["grid-template-columns"]).toBe("minmax(0, 1fr)");
  });
});
