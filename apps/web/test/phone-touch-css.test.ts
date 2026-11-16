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

  it.each([
    // The Tasks screen header and its empty state.
    [".tasks-sidebar-toggle", "width"],
    [".tasks-sidebar-toggle", "height"],
    [".tasks-refresh", "width"],
    [".tasks-refresh", "height"],
    [".tasks-header-actions .btn", "min-height"],
    [".tasks-empty .btn", "min-height"],
    // The new-task dialog and the detail sheet: buttons (Voice note, Activity, Add subtask), fields, selects.
    [".task-composer .btn", "min-height"],
    [".task-composer .icon-btn", "min-height"],
    [".task-composer .icon-btn", "min-width"],
    [".task-composer .text-input", "min-height"],
    [".task-detail-sheet .btn", "min-height"],
    [".task-detail-sheet .icon-btn", "min-height"],
    [".task-detail-sheet .icon-btn", "min-width"],
    [".task-detail-sheet .text-input", "min-height"],
    [".task-detail-sheet .select", "min-height"],
    // Every native select (Add provider's Provider, the dialogs'), and the Connect page.
    [".select", "min-height"],
    [".pairing-card .text-input", "min-height"],
    [".pairing-card .btn", "min-height"],
    ["summary.pairing-note", "min-height"],
  ])("%s has a 44px %s on a phone", (selector, property) => {
    expect(declarations(phone, selector)[property]).toMatch(TOUCH);
  });

  it.each([
    // Visual size stays: the 44px hit area is a pseudo-element drawn past the control edge (inset is from its padding box; the border adds the rest).
    [".switch::after", -10],
    [".accent-grid > button::after", -7],
  ])("%s extends the hit area to 44px without growing the control", (selector, inset) => {
    const rule = declarations(phone, selector);
    expect(rule["content"]).toBe('""');
    expect(rule["position"]).toBe("absolute");
    expect(rule["inset"]).toContain(`${inset}px`);
  });

  it("keeps the phone rules in one block that loads after the desktop overrides", () => {
    expect(phone).not.toBe("");
    const order = [...read("app.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1]);
    expect(order.indexOf("phone-touch.css")).toBeGreaterThan(order.indexOf("overrides-v3.css"));
  });
});

describe("the pin star on a touch screen", () => {
  const touch = mediaBlock(read("phone-touch.css"), "hover: none");

  it("is drawn, not hidden, where there is no hover to reveal it", () => {
    // Hover-only opacity 0 left an invisible 44px button in every row that pinned by accident.
    expect(declarations(touch, ".sidebar-star")["opacity"]).toBe("1");
  });
});

describe("the Connect page on a 375px screen", () => {
  it("lets the command to copy shrink and scroll, so the open card does not widen past the screen", () => {
    expect(declarations(phone, ".pairing-command code")["min-width"]).toBe("0");
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

const px = (value: string | undefined) => Number.parseFloat(value ?? "NaN");

describe("hit areas that must not overlap a neighbour", () => {
  it("keeps the task checkbox's 44px area clear of the title button: the row gap covers what pokes out", () => {
    // The 17px box is a 44px button with a -13.5px margin, so 13.5px of it sits over the row gap.
    // The gap has to be at least that, or the checkbox (painted above, being positioned) eats the title's left edge.
    const overhang = (44 - 17) / 2;
    expect(px(declarations(phone, ".dashboard-task")["gap"])).toBeGreaterThanOrEqual(overhang + 1);
  });

  it("gives a subtask row its own 44px, so neighbouring checkboxes do not overlap", () => {
    // 44px of content plus the row's 1px bottom rule.
    expect(declarations(phone, ".task-detail-child")["min-height"]).toBe("calc(var(--touch-target) + 1px)");
  });

  it("has no rule for a swatch class that nothing renders", () => {
    expect(read("phone-touch.css")).not.toMatch(/\.custom-swatch(?!\w)/);
  });
});

describe("the composer on a phone", () => {
  it("draws the + hit area 44px past its 1px border (inset is from the padding box)", () => {
    expect(declarations(phone, ".composer-row > .composer-plus::after")["inset"]).toBe("-5px");
  });

  it("makes the message field a 44px target", () => {
    expect(declarations(phone, ".composer-input")["min-height"]).toMatch(TOUCH);
  });
});

describe("the new-task dialog body", () => {
  const dialog = () => read("task-dialog.css");

  it("scrolls instead of squeezing its fields", () => {
    expect(declarations(dialog(), ".task-composer > *")["flex-shrink"]).toBe("0");
  });

  it("keeps the notes field about three lines tall", () => {
    expect(px(declarations(dialog(), ".task-composer .text-area")["min-height"])).toBeGreaterThanOrEqual(72);
  });

  it("loads after the rules it protects", () => {
    const order = [...read("app.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1]);
    expect(order.indexOf("task-dialog.css")).toBeGreaterThan(order.indexOf("phone-touch.css"));
  });
});

describe("the unpin button on a pinned tile", () => {
  const pins = strip(readFileSync(join(styles, "sidebar-pins.css"), "utf8"));
  const phonePins = mediaBlock(pins, "max-width: 720px");

  it("is 22px drawn with a 44px touch area (12px past the padding box, inside its 1px border)", () => {
    expect(declarations(pins, ".sidebar-tile-unpin")["width"]).toBe("22px");
    expect(declarations(phonePins, ".sidebar-tile-unpin::after")["inset"]).toBe("-12px");
  });

  it("leaves room above the first row so the scrolling list does not clip that area", () => {
    expect(px(declarations(pins, ".sidebar-grid")["padding-top"])).toBeGreaterThanOrEqual(8);
  });
});
