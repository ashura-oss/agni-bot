/**
 * What the app keeps of the policy frames: whether bots are paused (and which are off), today's
 * spend against the caps, and the runs a spend cap stopped. Pure: frames in, state and words out,
 * so the wording is tested without a screen. The app model owns one of these and forwards the
 * frames; nothing here talks to the network.
 */
import type { BotPauseState, RunCapsInfo, SpendCaps } from "@agni/protocol";
import type { IncomingFrame } from "./protocol";

export interface PauseView {
  paused: boolean;
  changedAt: string | null;
  /** How many running turns the change that caused the last frame stopped. */
  stopped: number;
  bots: BotPauseState[];
}

export interface SpendView {
  day: string;
  resetsAt: string;
  timeZone: string;
  caps: SpendCaps;
  daySpentUsd: number;
  bots: Array<{ agentID: string; spentUsd: number; capUsd: number | null }>;
  unpricedCalls: number;
  /** The run limits, shown read-only. Null when the daemon did not send them (an older daemon, or a read that failed). */
  runCaps: RunCapsInfo | null;
}

export type StopScope = "day" | "bot" | "job";
export type BudgetStopReason = "over_cap" | "cost_unknown" | "budget_unreadable";

/** A run a spend cap (or an uncountable spend) stopped, until the owner continues it or the bot starts again. */
export interface BudgetStop {
  runKey: string;
  agentID: string | null;
  scope: StopScope;
  reason: BudgetStopReason;
  spentUsd: number;
  capUsd: number;
  /** The notice as the daemon wrote it. Drawn as text, never markup. */
  message: string;
  /** Set once the daemon let the run go on: how many dollars it may spend on top of its caps. */
  continued: { grantedUsd: number } | null;
  /** The daemon could not continue it (the run is no longer stopped, or it restarted). */
  refused: boolean;
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$0.42"; under a cent "under $0.01"; nothing spent "$0.00". */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.005) return "under $0.01";
  return MONEY.format(usd);
}

export interface SpendLine {
  text: string;
  /** `unknown` when no status came: never shown as $0.00. */
  level: "ok" | "warn" | "full" | "unknown";
  /** The accessible name of the control that opens Settings, Spending. */
  label: string;
  /** What the control's description says beyond the text. */
  hint: string;
}

/** The line in the header: today's spend against the daily cap, with words as well as colour. */
export function spendLine(spend: SpendView | null): SpendLine {
  if (!spend) {
    return { text: "Today: spending unknown", level: "unknown", label: "Spending unknown. Open spending settings.", hint: "Could not load today's spending." };
  }
  const spent = money(spend.daySpentUsd);
  const cap = spend.caps.dayUsd;
  const unpriced = spend.unpricedCalls > 0 ? ` ${spend.unpricedCalls} ${spend.unpricedCalls === 1 ? "call had" : "calls had"} no price and ${spend.unpricedCalls === 1 ? "is" : "are"} not counted.` : "";
  if (cap === null) {
    return { text: `Today ${spent}`, level: "ok", label: `Spent ${spent} today, no daily limit. Open spending settings.`, hint: unpriced.trim() };
  }
  const limit = money(cap);
  if (spend.daySpentUsd >= cap) {
    return { text: `Today ${spent} of ${limit}. Limit reached.`, level: "full", label: `Spent ${spent} of ${limit} today. Limit reached. Open spending settings.`, hint: `Today's limit is reached.${unpriced}` };
  }
  const close = spend.daySpentUsd >= cap * 0.8;
  return {
    text: `Today ${spent} of ${limit}`,
    level: close ? "warn" : "ok",
    label: `Spent ${spent} of ${limit} today. Open spending settings.`,
    hint: `${close ? "Close to today's limit." : ""}${unpriced}`.trim(),
  };
}

/** The run limits as label and value pairs, in the words `agni policy caps` uses. */
export function runLimitLines(caps: RunCapsInfo): Array<{ label: string; value: string }> {
  const minutes = caps.rootJobWallMinutes;
  const time = Number.isInteger(minutes) ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : `${Math.round(minutes * 60)} seconds`;
  return [
    { label: "Time limit per run", value: time },
    { label: "Delegations at once", value: String(caps.maxConcurrentDelegations) },
    { label: "Self-scheduled jobs per bot", value: String(caps.maxSelfScheduledJobsPerBot) },
    { label: "Wakes per request", value: String(caps.maxWakesPerRequest) },
  ];
}

/** The headline of a stopped run and the "Raise" button for the limit that stopped it. `bot` is the asking bot's name, or null. */
export function stopTitle(stop: Pick<BudgetStop, "scope" | "reason">, bot: string | null): { headline: string; raise: string } {
  const name = bot ?? "A bot";
  const raise = stop.scope === "day" ? "Raise today's limit" : stop.scope === "bot" ? `Raise ${bot ?? "this bot"}'s limit` : "Raise the task limit";
  if (stop.reason === "cost_unknown") return { headline: `${name} stopped: a model call could not be priced, so the spend could not be counted.`, raise };
  if (stop.reason === "budget_unreadable") return { headline: `${name} stopped: the spending record could not be read.`, raise };
  if (stop.scope === "day") return { headline: `${name} stopped: today's spending limit is used up.`, raise };
  if (stop.scope === "bot") return { headline: `${name} stopped: ${name}'s daily limit is used up.`, raise };
  return { headline: `${name} stopped: this task reached its limit.`, raise };
}

export class PolicyState {
  /** Null until the daemon has said. */
  pause: PauseView | null = null;
  spend: SpendView | null = null;
  stops: BudgetStop[] = [];
  /** The daemon refused the caps the owner tried to save (`bad_cap`); the form shows it. Cleared by the next status. */
  capsError: string | null = null;
  /** What a screen reader is told when something here changes ("All bots paused."). Empty until a change. */
  announcement = "";

  /** Take a policy frame. True when the frame was one of ours (the caller then has nothing more to do with it). */
  apply(frame: IncomingFrame): boolean {
    if ("__unknown" in frame) return false;
    switch (frame.type) {
      case "policy.pause.ok": {
        const before = this.pause;
        this.pause = { paused: frame.paused, changedAt: frame.changedAt ?? null, stopped: frame.stopped, bots: frame.bots };
        if (before) {
          if (before.paused !== frame.paused) this.announcement = frame.paused ? "All bots paused." : "Bots resumed.";
          for (const bot of frame.bots) {
            const was = before.bots.find((candidate) => candidate.agentID === bot.agentID);
            if (was && was.enabled !== bot.enabled) this.announcement = `${bot.name} is ${bot.enabled ? "on" : "off"}.`;
          }
        }
        return true;
      }
      case "spend.status.ok":
        this.capsError = null;
        this.spend = {
          day: frame.day,
          resetsAt: frame.resetsAt,
          timeZone: frame.timeZone,
          caps: frame.caps,
          daySpentUsd: frame.daySpentUsd,
          bots: frame.bots,
          unpricedCalls: frame.unpricedCalls,
          runCaps: frame.runCaps ?? null,
        };
        return true;
      case "spend.stopped": {
        const stop: BudgetStop = {
          runKey: frame.runKey,
          agentID: frame.agentId ?? null,
          scope: frame.scope,
          reason: frame.reason,
          spentUsd: frame.spentUsd,
          capUsd: frame.capUsd,
          message: frame.message,
          continued: null,
          refused: false,
        };
        const at = this.stops.findIndex((candidate) => candidate.runKey === frame.runKey);
        if (at >= 0) this.stops[at] = stop;
        else this.stops.push(stop);
        return true;
      }
      case "spend.continue.ok": {
        const stop = this.stops.find((candidate) => candidate.runKey === frame.runKey);
        if (stop) {
          stop.continued = { grantedUsd: frame.grantedUsd };
          stop.refused = false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** The daemon would not continue this run (it is no longer stopped, or the daemon restarted). */
  continueRefused(runKey: string): void {
    const stop = this.stops.find((candidate) => candidate.runKey === runKey);
    if (stop) stop.refused = true;
  }

  /** A new turn of this bot started: its old stop notices have done their job. */
  clearStopsOf(agentID: string): void {
    this.stops = this.stops.filter((stop) => stop.agentID !== agentID);
  }

  /** Is this bot turned off (not "all paused": that is `pause.paused`)? */
  isOff(agentID: string): boolean {
    return this.pause?.bots.find((bot) => bot.agentID === agentID)?.enabled === false;
  }
}
