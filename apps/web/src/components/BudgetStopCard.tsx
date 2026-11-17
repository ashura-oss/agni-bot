/**
 * A run a spending limit stopped, drawn in the thread of the bot that stopped. The words are the
 * daemon's (`spend.stopped.message`, escaped like any card text); the buttons are "Raise the limit"
 * (Settings, Spending) and "Continue once", which belongs to this one run. Continue does not
 * restart the run: the daemon only lets it spend a little more, so the owner is told to send a message.
 */
import { useState } from "react";
import { OctagonAlert } from "lucide-react";
import { money, safeLine, stopTitle, type BudgetStop } from "@agni/client";
import { useAppModel } from "../state/use-app-model";

export function BudgetStopCard({ stop }: { stop: BudgetStop }) {
  const model = useAppModel();
  const [asked, setAsked] = useState(false);
  const name = model.requesterName(stop.agentID);
  const { headline, raise } = stopTitle(stop, name);
  // The daemon also writes the whole notice (what was spent, "work done so far is kept") into the thread as a message,
  // right above this card: the card repeats only its first line, with the buttons.
  const first = stop.message.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? headline;

  return (
    <div className="budget-stop-card" role="group" aria-label={headline}>
      <div className="card-heading">
        <OctagonAlert size={12} color="var(--ember)" />
        <span>{safeLine(first, 300)}</span>
      </div>
      {stop.continued ? (
        <p className="budget-stop-done" role="status">
          {`Done. This run may spend up to ${money(stop.continued.grantedUsd)} more. Send a message to carry on.`}
        </p>
      ) : (
        <>
          {stop.refused ? (
            <p className="budget-stop-done" role="status">
              This run can no longer be continued. Send your message again to start it.
            </p>
          ) : null}
          <div className="card-actions">
            <button type="button" className="btn small" onClick={() => model.openSettings("spending")}>
              {raise}
            </button>
            {stop.refused ? null : (
              <button
                type="button"
                className="btn small primary"
                disabled={asked}
                onClick={() => setAsked(model.continueSpend(stop.runKey))}
              >
                {asked ? "Continuing…" : "Continue once"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
