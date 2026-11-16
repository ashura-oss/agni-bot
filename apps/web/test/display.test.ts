import { describe, expect, it } from "vitest";
import { checkAgentName, describeFailure, failureOf, ownerInitials, plainPreview, providerLabel, writtenRole } from "../src/state/display";

describe("plainPreview", () => {
  it("removes markdown syntax from a sidebar preview (S1-40)", () => {
    expect(plainPreview("**Done.** I saved the `report` to [Drive](https://x.test/a).")).toBe("Done. I saved the report to Drive.");
    expect(plainPreview("## Plan\n- first step\n- second step")).toBe("Plan first step second step");
    expect(plainPreview("> quoted *text* here")).toBe("quoted text here");
    expect(plainPreview("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b 1 2");
    expect(plainPreview("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("leaves ordinary words, underscores and stars inside them alone", () => {
    expect(plainPreview("snake_case_name and 2 * 3 = 6")).toBe("snake_case_name and 2 * 3 = 6");
  });
});

describe("providerLabel", () => {
  it("drops the free suffix once the chosen model is not a free one (S1-40)", () => {
    expect(providerLabel({ label: "OpenRouter (:free)", model: "qwen/qwen3-max" })).toBe("OpenRouter");
    expect(providerLabel({ label: "OpenRouter (:free)", model: "meta-llama/llama-3.3-70b-instruct:free" })).toBe("OpenRouter (:free)");
    expect(providerLabel({ label: "Groq", model: "llama" })).toBe("Groq");
  });
});

describe("ownerInitials", () => {
  it("takes initials from a person's name and never from a device default (S1-40)", () => {
    expect(ownerInitials("Ada Lovelace's MacBook")).toBe("AL");
    expect(ownerInitials("Sam's Mac")).toBe("S");
    expect(ownerInitials("This PC")).toBeNull();
    expect(ownerInitials("This Browser")).toBeNull();
    expect(ownerInitials("")).toBeNull();
  });
});

describe("writtenRole", () => {
  it("treats the app's and the daemon's placeholder tags as empty (S1-40)", () => {
    expect(writtenRole("unnamed")).toBe("");
    expect(writtenRole("agent")).toBe("");
    expect(writtenRole(undefined)).toBe("");
    expect(writtenRole("Researcher")).toBe("Researcher");
  });
});

describe("checkAgentName", () => {
  it("rejects an empty name and one over 64 characters, and says why (S1-40)", () => {
    expect(checkAgentName("   ")).toEqual({ ok: false, message: "A name can't be empty." });
    const long = "x".repeat(65);
    const result = checkAgentName(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/64/);
    expect(checkAgentName("  Friday  ")).toEqual({ ok: true, name: "Friday" });
    expect(checkAgentName("x".repeat(64)).ok).toBe(true);
  });
});

describe("describeFailure", () => {
  const raw =
    'This turn failed: all providers failed — custom#1: HTTP 429: {"error":{"message":"mock: rate limited"}} | custom#2: HTTP 429: {"error":{"message":"mock: rate limited"}} | custom#3: HTTP 429: {"error":{"message":"mock: rate limited"}}';

  it("says a provider failure once, readably, keeping the raw text once as detail (S1-40)", () => {
    const failure = describeFailure(raw);
    expect(failure.summary).toBe("Couldn't get an answer: every model provider failed (rate limited).");
    expect(failure.summary).not.toMatch(/custom#|HTTP|\{/);
    expect(failure.detail?.match(/rate limited/g)?.length).toBe(3);
  });

  it("names each kind of cause once", () => {
    const failure = describeFailure("all providers failed — a#1: HTTP 401: no | b#2: HTTP 503: down | c#3: network timeout");
    expect(failure.summary).toBe("Couldn't get an answer: every model provider failed (the key was refused, the provider had an error, timed out).");
  });

  it("leaves a reason that is already readable alone", () => {
    expect(describeFailure("The model stopped because the daily limit was reached.")).toEqual({
      summary: "The model stopped because the daily limit was reached.",
      detail: null,
    });
  });

  it("recognises a stored failure message by its prefix and nothing else", () => {
    expect(failureOf(raw)).not.toBeNull();
    expect(failureOf("This turn failed was a great film")).toBeNull();
    expect(failureOf("Here is your answer")).toBeNull();
  });
});
