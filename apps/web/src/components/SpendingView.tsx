/**
 * Settings, Spending: today's spend (all bots, then each bot that spent), and the three limits that
 * stop a run. The daemon owns the numbers; this form only asks to change them, checks them first
 * the way the design words it, and says "Limits saved." when the daemon's own status shows them.
 */
import { useEffect, useId, useState } from "react";
import type { SpendCaps } from "@agni/protocol";
import { money, runLimitLines, safeLine, spendLine } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

type Field = "dayUsd" | "perBotDayUsd" | "perJobUsd";

const FIELDS: Array<{ id: Field; label: string; hint?: string }> = [
  { id: "dayUsd", label: "Daily limit, all bots" },
  { id: "perBotDayUsd", label: "Daily limit, each bot" },
  // The daemon applies this cap only to a run with a root job (policy/budget.ts): chats never hit it.
  {
    id: "perJobUsd",
    label: "Limit per background job",
    hint: "Covers scheduled jobs and the work they hand to other bots. Chats count toward the daily limits only.",
  },
];

function show(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

/** "2", "2.5", "$2.00" are amounts; anything else is not. Returns dollars, or the words to show under the field. */
function parseAmount(text: string): { ok: true; usd: number } | { ok: false; message: string } {
  const cleaned = text.trim().replace(/^\$\s*/u, "");
  if (!/^\d+(\.\d{1,2})?$/u.test(cleaned)) return { ok: false, message: "Enter an amount, like 2.00." };
  const usd = Number(cleaned);
  if (!(usd > 0)) return { ok: false, message: "Must be more than $0.00." };
  return { ok: true, usd };
}

export function SpendingView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const spend = snapshot.policy.spend;
  const ids = useId();
  const [draft, setDraft] = useState<Record<Field, string>>(() => ({
    dayUsd: show(spend?.caps.dayUsd ?? null),
    perBotDayUsd: show(spend?.caps.perBotDayUsd ?? null),
    perJobUsd: show(spend?.caps.perJobUsd ?? null),
  }));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [sent, setSent] = useState<SpendCaps | null>(null);

  // The daemon's numbers fill the form until the owner starts typing.
  useEffect(() => {
    if (dirty || !spend) return;
    setDraft({ dayUsd: show(spend.caps.dayUsd), perBotDayUsd: show(spend.caps.perBotDayUsd), perJobUsd: show(spend.caps.perJobUsd) });
  }, [spend, dirty]);

  const saved =
    sent !== null &&
    spend !== null &&
    spend.caps.dayUsd === sent.dayUsd &&
    spend.caps.perBotDayUsd === sent.perBotDayUsd &&
    spend.caps.perJobUsd === sent.perJobUsd;

  const save = (): void => {
    const next: Partial<Record<Field, string>> = {};
    const values: Partial<Record<Field, number>> = {};
    for (const field of FIELDS) {
      const parsed = parseAmount(draft[field.id]);
      if (parsed.ok) values[field.id] = parsed.usd;
      else next[field.id] = parsed.message;
    }
    if (values.dayUsd !== undefined && values.perBotDayUsd !== undefined && values.perBotDayUsd > values.dayUsd) {
      next.perBotDayUsd = "Each bot's limit cannot be more than the daily limit.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const caps: SpendCaps = { dayUsd: values.dayUsd!, perBotDayUsd: values.perBotDayUsd!, perJobUsd: values.perJobUsd! };
    setSent(caps);
    model.saveSpendCaps(caps);
  };

  const line = spendLine(spend);
  const spenders = (spend?.bots ?? []).filter((bot) => bot.spentUsd > 0);

  const runLimits = spend?.runCaps ? runLimitLines(spend.runCaps) : null;

  return (
    <div className="settings-section spending-view">
      <div className="settings-group">
        <h3 className="spending-today">
          {spend ? `Today: ${money(spend.daySpentUsd)}${spend.caps.dayUsd !== null ? ` of ${money(spend.caps.dayUsd)}` : ""}` : line.text}
        </h3>
        {spend ? (
          spenders.length > 0 ? (
            <ul className="spending-bots" aria-label="Spending by bot">
              {spenders.map((bot) => (
                <li key={bot.agentID}>
                  <span>{safeLine(model.requesterName(bot.agentID) ?? bot.agentID, 80)}</span>
                  <span>{bot.capUsd !== null ? `${money(bot.spentUsd)} of ${money(bot.capUsd)}` : money(bot.spentUsd)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-note">No spending yet today.</p>
          )
        ) : (
          <p className="settings-note">{line.hint}</p>
        )}
        {line.hint && spend ? <p className="settings-note">{line.hint}</p> : null}
      </div>

      <form
        className="settings-group spending-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        noValidate
      >
        {FIELDS.map((field) => {
          const error = errors[field.id];
          const hintID = field.hint ? `${ids}-${field.id}-hint` : null;
          const errorID = error ? `${ids}-${field.id}-error` : null;
          const describedBy = [hintID, errorID].filter((id): id is string => id !== null).join(" ");
          return (
            <div className="spending-field" key={field.id}>
              <label htmlFor={`${ids}-${field.id}`}>{field.label}</label>
              <div className="spending-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`${ids}-${field.id}`}
                  className="text-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft[field.id]}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={describedBy || undefined}
                  onChange={(event) => {
                    setDraft({ ...draft, [field.id]: event.target.value });
                    setDirty(true);
                    setSent(null);
                  }}
                />
              </div>
              {hintID ? (
                <p id={hintID} className="settings-note spending-hint">
                  {field.hint}
                </p>
              ) : null}
              {error ? (
                <span id={`${ids}-${field.id}-error`} className="spending-error">
                  {error}
                </span>
              ) : null}
            </div>
          );
        })}
        <p className="settings-note">
          Costs are estimates from model prices.
          {spend ? ` Resets at ${new Date(spend.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${spend.timeZone ? ` (${spend.timeZone})` : ""}.` : ""}
        </p>
        {snapshot.policy.capsError ? (
          <p className="approval-notice" role="alert">
            {snapshot.policy.capsError}
          </p>
        ) : null}
        <div className="spending-actions">
          <button type="submit" className="btn primary">
            Save limits
          </button>
          {saved ? (
            <span className="spending-saved" role="status">
              Limits saved.
            </span>
          ) : null}
        </div>
      </form>

      <div className="settings-group run-limits-group">
        <h3>Run limits</h3>
        {runLimits ? (
          <ul className="spending-bots run-limits" aria-label="Run limits">
            {runLimits.map((line) => (
              <li key={line.label}>
                <span>{line.label}</span>
                <span>{line.value}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-note">Run limits are not available right now.</p>
        )}
        <p className="settings-note">
          Change these in a terminal with <code className="code">agni policy caps set</code>.
        </p>
      </div>
    </div>
  );
}
