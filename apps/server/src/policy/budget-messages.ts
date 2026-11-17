/**
 * What the owner reads when a run is stopped for spending or for the pause switch. The wording is the card
 * design's (`project-log/design/s2-cards.md`, sections 3 and 4): the bot's name, one idea per line, money with
 * two decimals, and "Work done so far is kept." under every budget stop.
 *
 * The bot's name is the owner's own naming, but it can come from a bot that renamed itself, so it goes
 * through the card text escape like everything else the owner reads that a bot could have written.
 */
import { entry } from "../agent/card-text";
import type { RouteRefusedError } from "../models/router";
import type { BudgetStopDetail } from "./types";

/** `$0.42`; under one cent says so; zero is `$0.00`. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}

function nameOf(botName: string | null | undefined): string {
  const name = botName?.trim();
  return name ? entry(name, 60) : "A bot";
}

const KEPT = "Work done so far is kept.";

/** The notice for a run a spend cap (or a spend that cannot be counted) stopped. Three lines, no markup. */
export function budgetStopMessage(botName: string | null | undefined, detail: BudgetStopDetail): string {
  const bot = nameOf(botName);
  const spent = money(detail.spentUsd);
  const cap = money(detail.capUsd);
  if (detail.reason === "budget_unreadable") {
    return [`${bot} stopped: spending could not be checked, so nothing more was run.`, KEPT].join("\n");
  }
  if (detail.reason === "cost_unknown") {
    const where = detail.scope === "job" ? "this task" : detail.scope === "bot" ? `${bot}'s spending today` : "today's spending";
    return [`${bot} stopped: part of ${where} could not be priced, so the limit cannot be checked.`, "Choose Continue once to let this run go on.", KEPT].join("\n");
  }
  switch (detail.scope) {
    case "day":
      return [`${bot} stopped: today's spending limit is used up.`, `Spent ${spent} of ${cap} today. All bots are stopped until midnight.`, KEPT].join("\n");
    case "bot":
      return [`${bot} stopped: ${bot}'s daily limit is used up.`, `${bot} spent ${spent} of ${cap} today. Other bots keep working.`, KEPT].join("\n");
    case "job":
      return [`${bot} stopped: this task reached its limit.`, `This task cost ${spent} of ${cap}.`, KEPT].join("\n");
  }
}

/** The stop notice for a pause. `unavailable` means the switch could not be read, which stops everything. */
export function pauseStopMessage(botName: string | null | undefined, verdict: { scope: "all" | "bot"; unavailable?: boolean }): string {
  if (verdict.unavailable) return "Stopped: the pause switch could not be read, so nothing more was run.";
  if (verdict.scope === "bot") return `Stopped: you turned ${nameOf(botName)} off. ${KEPT}`;
  return `Stopped: you paused all bots. ${KEPT} Ask again after you resume to carry on.`;
}

/** "30 minutes", "1 minute", "45 seconds": a cap the owner set, as they would say it. */
function spanWords(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * The stop notice for a root job past its time limit. `unknown` means its start could not be read,
 * which stops it the same way: a clock that cannot be checked is not one that has not run out.
 */
export function wallTimeStopMessage(botName: string | null | undefined, verdict: { wallMs: number | null; unknown?: boolean }): string {
  const bot = nameOf(botName);
  if (verdict.unknown || verdict.wallMs === null) {
    return `${bot} stopped: it could not be checked how long this task has been running, so nothing more was run. ${KEPT}`;
  }
  return `${bot} stopped: this task has run for its time limit of ${spanWords(verdict.wallMs)}. ${KEPT}`;
}

const BUDGET_REASONS = new Set(["over_cap", "cost_unknown", "budget_unreadable"]);
const SCOPES = new Set(["day", "bot", "job"]);

/** What a refusal from the router's gate says about the budget, or null when it was not a budget refusal. */
export function budgetStopFromRefusal(error: RouteRefusedError): BudgetStopDetail | null {
  if (!BUDGET_REASONS.has(error.reason)) return null;
  const { scope, spentUsd, capUsd } = error.detail as { scope?: unknown; spentUsd?: unknown; capUsd?: unknown };
  return {
    scope: typeof scope === "string" && SCOPES.has(scope) ? (scope as BudgetStopDetail["scope"]) : "day",
    reason: error.reason as BudgetStopDetail["reason"],
    spentUsd: typeof spentUsd === "number" ? spentUsd : 0,
    capUsd: typeof capUsd === "number" ? capUsd : 0,
  };
}
