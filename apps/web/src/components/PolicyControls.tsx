/**
 * The always-there controls of the policy core: pause every bot, today's spend, the banner while
 * paused, one bot's on/off switch, and what a screen reader hears when any of it changes.
 * Wording is the design's (`s2-cards.md` sections 3 and 4). Nothing here hard-codes a colour.
 */
import { useId, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { safeLine, spendLine, type AgentInfo } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { Switch } from "./bits";
import { useDialog } from "./use-dialog";

/** What a screen reader is told when the bots are paused or resumed, or one is turned off or on. Always drawn. */
export function PolicyAnnouncer() {
  const snapshot = useAppSnapshot();
  return (
    <span className="visually-hidden" role="status">
      {snapshot.policy.announcement}
    </span>
  );
}

/** One click pauses every bot, with no question: it is the emergency stop, and one click undoes it. */
export function PauseButton() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const paused = snapshot.policy.pause?.paused === true;
  const label = paused ? "Resume all bots" : "Pause all bots";
  return (
    <button
      type="button"
      className={`policy-pause${paused ? " on" : ""}`}
      aria-label={label}
      title={label}
      onClick={() => model.setAllPaused(!paused)}
    >
      {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
      <span className="policy-pause-text">{label}</span>
    </button>
  );
}

/** "Today $0.42 of $2.00": opens Settings, Spending. Never $0.00 for a spend the daemon has not told. */
export function SpendChip() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const hintID = useId();
  const line = spendLine(snapshot.policy.spend);
  const lead = line.text.startsWith("Today ") ? "Today " : "";
  const rest = line.text.slice(lead.length);
  const tailAt = rest.indexOf(". Limit reached");
  const body = tailAt >= 0 ? rest.slice(0, tailAt) : rest;
  const tail = tailAt >= 0 ? rest.slice(tailAt) : "";
  // "$0.42 of $2.00": on a phone the two halves stack, so the chip is narrow enough for the header.
  const [amount = "", ...limitParts] = body.split(" of ");
  const limit = limitParts.length > 0 ? `of ${limitParts.join(" of ")}` : "";
  return (
    <>
      <button
        type="button"
        className="spend-chip"
        data-level={line.level}
        aria-label={line.label}
        aria-describedby={line.hint ? hintID : undefined}
        onClick={() => model.openSettings("spending")}
      >
        {lead ? <span className="spend-chip-lead">{lead}</span> : null}
        <span className="spend-chip-body">
          <span>{amount}</span>
          {limit ? (
            <>
              {" "}
              <span>{limit}</span>
            </>
          ) : null}
        </span>
        {tail ? <span className="spend-chip-tail">{tail}</span> : null}
      </button>
      {line.hint ? (
        <span id={hintID} className="visually-hidden">
          {line.hint}
        </span>
      ) : null}
    </>
  );
}

/** Under the header while every bot is paused. */
export function PauseBanner() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  if (snapshot.policy.pause?.paused !== true) return null;
  return (
    <div className="pause-banner">
      <span>All bots are paused. Nothing new will start.</span>
      <button type="button" className="btn small" onClick={() => model.setAllPaused(false)}>
        Resume all bots
      </button>
    </div>
  );
}

/** "Ava is on" / "Ava is off": the bot's own switch, at the top of its profile. */
export function BotPowerSwitch({ agent }: { agent: AgentInfo }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [asking, setAsking] = useState(false);
  const off = model.isBotOff(agent.id);
  const name = safeLine(agent.name, 80);
  const state = snapshot.policy.pause?.bots.find((bot) => bot.agentID === agent.id);
  const busy = (state?.runningTurns ?? 0) > 0 || (state?.scheduledJobs ?? 0) > 0;
  return (
    <div className="bot-power">
      <span className="bot-power-text">{`${name} is ${off ? "off" : "on"}`}</span>
      <Switch
        checked={!off}
        label={name}
        onChange={(next) => {
          // Turning off something that is running or scheduled asks first; nothing else does.
          if (!next && busy) setAsking(true);
          else model.setBotEnabled(agent.id, next);
        }}
      />
      {asking ? (
        <TurnOffDialog
          name={name}
          running={state?.runningTurns ?? 0}
          scheduled={state?.scheduledJobs ?? 0}
          onKeepOn={() => setAsking(false)}
          onTurnOff={() => {
            setAsking(false);
            model.setBotEnabled(agent.id, false);
          }}
        />
      ) : null}
    </div>
  );
}

function TurnOffDialog({
  name,
  running,
  scheduled,
  onKeepOn,
  onTurnOff,
}: {
  name: string;
  running: number;
  scheduled: number;
  onKeepOn: () => void;
  onTurnOff: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleID = useId();
  // The safe button takes focus, and Escape means "keep it on".
  useDialog(ref, onKeepOn, ".keep-on");
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onKeepOn();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleID} ref={ref}>
        <h2 id={titleID}>{`Turn off ${name}?`}</h2>
        {running > 0 ? <p>{`${name}'s ${running === 1 ? "running task" : `${running} running tasks`} will stop.`}</p> : null}
        {scheduled > 0 ? (
          <p>{`${name}'s ${scheduled === 1 ? "scheduled job" : `${scheduled} scheduled jobs`} will not run until you turn ${name} back on.`}</p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn keep-on" onClick={onKeepOn}>
            {`Keep ${name} on`}
          </button>
          <span className="spacer" />
          <button type="button" className="btn danger" onClick={onTurnOff}>
            {`Turn off ${name}`}
          </button>
        </div>
      </div>
    </div>
  );
}
