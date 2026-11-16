/**
 * Inspector: the agent, the routines it runs without being asked, the
 * connections it depends on, and today's numbers. Everything here is either
 * reported by the daemon or absent — nothing is estimated.
 */
import { useEffect, useState } from "react";
import { ChevronDown, Plus, RefreshCw } from "lucide-react";
import { format, ownerJobs, recurrenceLabel, type JobInfo, type MemoryItem, type TaskInfo } from "@agni/client";
import type { RoutineInfo, RoutineRunInfo } from "@agni/protocol";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { AgentAvatar, PresenceDot } from "./bits";
import { AddProviderView } from "./AddProviderView";
import { jobKindLabel, plainJobResult, providerLabel } from "../state/display";

export function InspectorView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const memories = snapshot.memories;
  const [addingProvider, setAddingProvider] = useState(false);
  const agent = model.agent;
  const openTasks = snapshot.tasks.filter((task) => task.status !== "done");
  const completed = snapshot.tasks.filter((task) => task.status === "done").slice(0, 5);
  // The daemon's own housekeeping jobs (tagger, backups, ...) are not the owner's to manage.
  const jobs = ownerJobs(snapshot.jobs);
  // A fixed order (by name): the daemon lists jobs by state and next run, so rows would otherwise
  // trade places under the cursor whenever one runs, and a second click would hit another job.
  const byName = (a: JobInfo, b: JobInfo) => jobName(a).localeCompare(jobName(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const recurring = jobs.filter((job) => job.routine !== undefined || job.everyMs !== undefined || job.dailyAt !== undefined || job.kind === "brief").sort(byName);
  const scheduled = jobs.filter((job) => !(job.routine !== undefined || job.everyMs !== undefined || job.dailyAt !== undefined || job.kind === "brief")).sort(byName);

  return (
    <aside className="inspector">
      <section className="card inspector-agent">
        <div className="inspector-agent-head">
          <AgentAvatar agent={agent} alive={snapshot.conversation.isStreaming} size="large" />
          <div>
            <div className="inspector-agent-name">{agent?.name ?? "Your bot"}</div>
            <div className="inspector-presence">
              <PresenceDot online={snapshot.connectionState.kind === "ready"} />
              {snapshot.connectionState.kind === "ready" ? "Available" : "Offline"}
            </div>
          </div>
        </div>
        <Row label="Model" value={agent?.model ?? "routed by the daemon"} />
        <Row label="Lane" value="task — tools; up to 48 steps per chain (24 when delegated), 25 tool calls per reply" />
        <Row
          label="Tools"
          value={agent?.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "none in this lane"}
        />
      </section>

      <section className="inspector-section">
        <div className="inspector-section-head">
          <div className="section-title">Tasks</div>
          <button type="button" className="link" onClick={() => model.refreshTasks()}>
            Refresh
          </button>
        </div>
        {openTasks.length === 0 ? (
          <div className="empty-note">
            <strong>No open tasks</strong>
            <span>Capture one in chat with “add task: …”.</span>
          </div>
        ) : (
          openTasks.map((task) => <TaskRow key={task.id} task={task} />)
        )}
        {completed.length > 0 ? (
          <>
            <div className="section-title" style={{ paddingTop: 4 }}>
              Completed recently
            </div>
            {completed.map((task) => (
              <div key={task.id} className="settings-row">
                <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.title}
                </span>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => model.updateTask(task, "reopen")}>
                  Reopen
                </button>
              </div>
            ))}
          </>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-head">
          <div className="section-title">Memory</div>
          <button type="button" className="link" onClick={() => model.refreshMemories()}>
            Refresh
          </button>
        </div>
        {memories.length === 0 ? (
          <div className="empty-note">
            <strong>Nothing remembered yet</strong>
            <span>Facts the agent keeps show up here — only the ones it can actually recall.</span>
          </div>
        ) : (
          memories.map((memory) => <MemoryRow key={memory.id} memory={memory} />)
        )}
      </section>

      <section className="inspector-section">
        <div className="section-title">Routines</div>
        {jobs.length === 0 ? (
          <div className="empty-note">
            <strong>Nothing scheduled</strong>
            <span>
              Routines are background turns the daemon runs while you are away. Add one with
              bun run job add "…" --every 1h, or ask your bot to create one.
            </span>
          </div>
        ) : null}
        {recurring.map((job) => (
          <RoutineRow key={job.id} job={job} />
        ))}
        {scheduled.length > 0 ? (
          <div className="section-title" style={{ paddingTop: 4 }}>
            Scheduled
          </div>
        ) : null}
        {scheduled.map((job) => (
          <RoutineRow key={job.id} job={job} />
        ))}
        {jobs.length > 0 ? (
          <button type="button" className="link" onClick={() => model.refreshJobs()} style={{ alignSelf: "flex-start" }}>
            Refresh
          </button>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="section-title">Connections</div>
        <button
          type="button"
          className="btn small"
          style={{ alignSelf: "flex-start" }}
          disabled={snapshot.connectionState.kind !== "ready"}
          onClick={() => {
            model.prepareToAddProvider();
            setAddingProvider(true);
          }}
        >
          <Plus size={12} /> Add provider
        </button>
        {snapshot.health ? (
          snapshot.health.providers.length === 0 ? (
            <div className="empty-note">
              <strong>No providers configured</strong>
              <span>Add a provider key here. Agni stores it on the daemon host.</span>
            </div>
          ) : (
            snapshot.health.providers.map((provider) => (
              <div key={provider.id} className="provider-row">
                <span className={`provider-dot${provider.available ? "" : " off"}`} style={{ marginTop: 5 }} />
                <div className="provider-main">
                  <div className="provider-name">{providerLabel(provider)}</div>
                  <div className="provider-model">{provider.model}</div>
                  {!provider.available ? (
                    <div className="provider-note warning-text">
                      {provider.cooldownRemainingMs > 0
                        ? `Cooling ${Math.trunc(provider.cooldownRemainingMs / 1000)}s${
                            provider.lastError ? ` — ${provider.lastError}` : ""
                          }`
                        : provider.lastError ?? "Unavailable"}
                    </div>
                  ) : null}
                  <div className="provider-note">{provider.tiers.join(" · ")}</div>
                </div>
              </div>
            ))
          )
        ) : (
          <div className="empty-note">
            <strong>Daemon status unavailable</strong>
            <span>{snapshot.healthError ?? "Waiting for /health…"}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <div className="section-title">Today</div>
        {snapshot.health ? (
          <>
            <Row label="Turns" value={snapshot.health.usageToday.turns.toLocaleString()} />
            <Row
              label="Tokens"
              value={`${snapshot.health.usageToday.inputTokens.toLocaleString()} in · ${snapshot.health.usageToday.outputTokens.toLocaleString()} out`}
            />
            <Row
              label="Daemon"
              value={`up ${format.uptime(snapshot.health.uptimeMs)} · protocol v${snapshot.health.v}`}
            />
          </>
        ) : (
          <Row label="Usage" value="unknown" />
        )}
        <p className="settings-note">
          Free-tier providers are the default; if a NIM pay-as-you-go key is set, spend is
          capped by the daemon's daily limits.
        </p>
      </section>

      <section className="inspector-section">
        <div className="section-title">This Browser</div>
        <Row label="Server" value={snapshot.settings.url} />
        <Row
          label="Token"
          value={snapshot.secretKind === "memory" ? "kept for this session" : "stored in browser storage"}
        />
        <Row label="Device" value={snapshot.settings.deviceName} />
        <button
          type="button"
          className="btn small"
          style={{ alignSelf: "flex-start" }}
          onClick={() => model.forgetDevice()}
        >
          Forget this device
        </button>
        <p className="settings-note">
          Forgetting removes the token from this browser. The server still knows the device
          until you revoke it with bun run devices.
        </p>
      </section>

      {addingProvider ? <AddProviderView onDismiss={() => setAddingProvider(false)} /> : null}
    </aside>
  );
}

/** Owner-only: the bot cannot widen its own egress, so this is the only place domains change. */
function DomainsEditor({ job, domains }: { job: JobInfo; domains: string[] }) {
  const model = useAppModel();
  const [draft, setDraft] = useState(domains.join(", "));
  const save = () => model.setRoutineDomains(job, draft.split(",").map((entry) => entry.trim()).filter(Boolean));
  return (
    <div className="kv-row">
      <span className="kv-label">Domains</span>
      <input
        className="kv-value"
        aria-label="Routine domains"
        placeholder="none"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
      <button type="button" className="btn small" onClick={save}>
        Save
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}

/**
 * One remembered thing. The owner can see what the agent holds and where it
 * came from; the list is filtered the way retrieval filters it, so nothing
 * shows here that the agent could not have recalled.
 */
function MemoryRow({ memory }: { memory: MemoryItem }) {
  const used = memory.useCount > 0;
  return (
    <div className="memory-row">
      <div className="memory-text">{memory.text}</div>
      <div className="memory-meta">
        <span>{memory.scope}</span>
        <span>·</span>
        <span>{memory.source}</span>
        <span>·</span>
        <span title="How sure the agent is">{(memory.confidence * 100).toFixed(0)}%</span>
        {used ? (
          <>
            <span>·</span>
            <span title="How often it is recalled">used {memory.useCount}×</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TaskRow({ task }: { task: TaskInfo }) {
  const model = useAppModel();
  const due = task.dueAt ? format.parseISO(task.dueAt) : null;
  const meta = [
    due ? `Due ${format.stamp(due)}` : null,
    task.priority.charAt(0).toUpperCase() + task.priority.slice(1),
    task.status.charAt(0).toUpperCase() + task.status.slice(1),
    task.delegateState && task.delegateState !== "none"
      ? `${task.ownerAgentId ?? "agent"} · ${task.delegateState.replace("_", " ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const cancellable =
    task.delegateState === "queued" || task.delegateState === "running" || task.delegateState === "needs_input";
  return (
    <div className="task-row">
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">{meta}</div>
      </div>
      <select
        className="select btn small"
        style={{ width: 88, padding: "3px 20px 3px 8px", fontSize: 11 }}
        defaultValue=""
        aria-label={`Snooze ${task.title}`}
        onChange={(event) => {
          const value = event.target.value;
          event.currentTarget.value = "";
          if (value === "hour") {
            model.updateTask(task, "snooze", new Date(Date.now() + 3_600_000));
          } else if (value === "tomorrow") {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            model.updateTask(task, "snooze", tomorrow);
          }
        }}
      >
        <option value="" disabled>
          Snooze
        </option>
        <option value="hour">1 hour</option>
        <option value="tomorrow">Tomorrow</option>
      </select>
      {cancellable ? (
        <button type="button" className="btn small" onClick={() => model.updateTask(task, "cancel")}>
          Cancel
        </button>
      ) : null}
      <button type="button" className="btn primary small" onClick={() => model.updateTask(task, "done")}>
        Done
      </button>
    </div>
  );
}

const OUTCOME_LABEL: Record<RoutineRunInfo["outcome"], string> = {
  ran: "Ran",
  skipped_no_delta: "Skipped, no change",
  failed: "Failed",
  timed_out: "Timed out",
  budget_exceeded: "Over budget",
};

/**
 * "Daily at 09:00 · Europe/London" for the cron shapes routines are usually
 * written in; anything else keeps the raw cron string.
 */
function humanCadence(cron: string, timezone: string): string {
  const fields = cron.trim().split(/\s+/u);
  const zone = ` · ${timezone}`;
  if (fields.length !== 5) return `${cron}${zone}`;
  const [minute = "", hour = "", dom, month, dow] = fields;
  const hourStep = hour.match(/^\*\/(\d+)$/u);
  const minuteStep = minute.match(/^\*\/(\d+)$/u);
  if (minuteStep && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${format.count(Number(minuteStep[1]), "minute")}${zone}`;
  }
  if (minute === "0" && hourStep && dom === "*" && month === "*" && dow === "*") {
    return `Every ${format.count(Number(hourStep[1]), "hour")}${zone}`;
  }
  if (/^\d+$/u.test(minute) && /^\d+$/u.test(hour) && Number(minute) < 60 && Number(hour) < 24 && dom === "*" && month === "*") {
    const clock = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    if (dow === "*" || dow === "0-6") return `Daily at ${clock}${zone}`;
    if (dow === "1-5") return `Weekdays at ${clock}${zone}`;
  }
  return `${cron}${zone}`;
}

/**
 * "Run now" for one job. The daemon starts a second copy if asked while the
 * first is running, so the button stays off while the job runs, and from the
 * click until the job's state moves (the daemon answers the click at once with
 * the job still queued, so that first report does not count).
 */
function jobName(job: JobInfo): string {
  return job.routine?.name ?? (job.title && job.title.length > 0 ? job.title : jobKindLabel(job.kind));
}

function useRunNow(job: JobInfo): { busy: boolean; start: () => void } {
  const model = useAppModel();
  const refusals = useAppSnapshot().runRefusals;
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    setRequested(false);
  }, [job.state, job.attempts, job.lastResult]);
  // The daemon said it is already running: stand down at once, it will report the job itself.
  useEffect(() => {
    setRequested(false);
  }, [refusals]);
  useEffect(() => {
    if (!requested) return;
    // If the daemon never reports back, do not leave the button off for good.
    const timer = setTimeout(() => setRequested(false), 8000);
    return () => clearTimeout(timer);
  }, [requested]);
  return {
    busy: job.state === "running" || requested,
    start: () => {
      if (job.state === "running" || requested) return;
      setRequested(true);
      model.runRoutine(job);
    },
  };
}

function RoutineRow({ job }: { job: JobInfo }) {
  return job.routine ? <CronRoutineRow job={job} routine={job.routine} /> : <PlainRoutineRow job={job} />;
}

function PlainRoutineRow({ job }: { job: JobInfo }) {
  const model = useAppModel();
  const runAt = format.parseISO(job.runAt);
  // The daemon reports how a job repeats: every N minutes (`everyMs`) or on a clock
  // (`dailyAt`, `days`). A server old enough not to send `internal` does not send
  // `dailyAt` either, so there a one-off cannot be told from a clock job: say when it
  // runs next rather than claiming it runs once.
  const clock = recurrenceLabel(job);
  const knowsRecurrence = job.internal !== undefined;
  const next = job.enabled && runAt ? ` · next ${format.stamp(runAt)}` : "";
  const timing =
    job.state === "running"
      ? "Running now"
      : job.everyMs !== undefined
        ? `${format.cadence(job.everyMs, runAt)}${next}`
        : clock
          ? `${clock}${next}`
          : knowsRecurrence
            ? runAt
              ? `Once · ${job.state === "done" ? "ran" : "runs"} ${format.stamp(runAt)}`
              : "Once"
            : runAt
              ? `${job.state === "done" ? "Last ran" : "Next run"} ${format.stamp(runAt)}`
              : "Scheduled";
  const run = useRunNow(job);
  return (
    <div className="routine-row">
      <div className="routine-main">
        <div className="routine-title">{jobName(job)}</div>
        <div className="routine-meta">{timing}</div>
        {job.lastResult && job.lastResult.length > 0 ? (
          <div className="routine-meta tertiary">{format.preview(plainJobResult(job.lastResult), 90)}</div>
        ) : null}
        {job.state === "failed" ? (
          <div className="routine-meta warning-text">Failed after {job.attempts} attempts</div>
        ) : null}
        {!job.enabled ? <div className="routine-meta tertiary">Paused</div> : null}
      </div>
      <button
        type="button"
        className="icon-btn"
        title={run.busy ? "Running now" : "Run now"}
        aria-label={`Run ${jobName(job)} now`}
        disabled={run.busy}
        onClick={run.start}
      >
        <RefreshCw size={12} />
      </button>
      <input
        type="checkbox"
        className="toggle"
        checked={job.enabled}
        aria-label={`${jobName(job)} routine`}
        title={job.enabled ? "Pause this routine" : "Resume this routine"}
        onChange={(event) => model.setRoutine(job, event.target.checked)}
      />
    </div>
  );
}

/**
 * A routine with its details. The header is the summary; clicking it shows
 * the last five runs, the config, and the actions. The full reports are in
 * the conversation, so "Open report" goes there.
 */
function CronRoutineRow({ job, routine }: { job: JobInfo; routine: RoutineInfo }) {
  const model = useAppModel();
  const [expanded, setExpanded] = useState(false);
  const runs = routine.recentRuns;
  const last = runs[0];
  const lastAt = last ? format.parseISO(last.at) : null;
  const next = format.parseISO(job.runAt);
  const skipped = runs.filter((run) => run.outcome === "skipped_no_delta");
  const skippedTokens = skipped.reduce((sum, run) => sum + run.tokens, 0);
  const timing =
    job.state === "running" ? "Running now" : !job.enabled ? "Paused" : next ? `next ${format.stamp(next)}` : null;
  const streak =
    routine.failureStreak > 0
      ? `${routine.failureStreak} failed in a row`
      : routine.successStreak > 0
        ? `${routine.successStreak} ok in a row`
        : null;
  const threadID = job.threadID;
  const run = useRunNow(job);

  return (
    <div className="routine-row">
      <button
        type="button"
        className="routine-main routine-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="routine-title">
          {routine.name}
          <ChevronDown size={12} className="routine-chevron" aria-hidden="true" />
        </span>
        <span className="routine-meta">
          {[humanCadence(routine.cron, routine.timezone), timing].filter(Boolean).join(" · ")}
        </span>
        <span className={`routine-meta${routine.failureStreak > 0 ? " warning-text" : ""}`}>
          {last
            ? [
                `Last ${OUTCOME_LABEL[last.outcome].toLowerCase()}`,
                lastAt ? format.stamp(lastAt) : null,
                streak,
              ]
                .filter(Boolean)
                .join(" · ")
            : ["No runs yet", streak].filter(Boolean).join(" · ")}
        </span>
      </button>
      {expanded ? (
        <div className="routine-detail">
          {runs.length > 0 ? (
            <div className="routine-meta">
              {`${skipped.length} of last ${runs.length} runs skipped, ${skippedTokens.toLocaleString()} tokens`}
            </div>
          ) : null}
          {runs.map((run, index) => (
            <RoutineRunLine key={index} run={run} />
          ))}
          <Row label="Pre-flight" value={routine.preflight} />
          <Row label="Max tokens" value={routine.maxTokens.toLocaleString()} />
          <Row label="Max time" value={`${routine.maxExecutionMs.toLocaleString()} ms`} />
          <DomainsEditor job={job} domains={routine.allowedDomains} />
          <div className="routine-actions">
            <button type="button" className="btn small" onClick={() => model.setRoutine(job, !job.enabled)}>
              {job.enabled ? "Pause" : "Resume"}
            </button>
            <button type="button" className="btn small" disabled={run.busy} onClick={run.start}>
              {run.busy ? "Running…" : "Run now"}
            </button>
            <button
              type="button"
              className="btn small"
              disabled={job.state === "running"}
              onClick={() => {
                if (window.confirm(`Delete routine "${routine.name}" and its run history?`)) model.deleteTask(job);
              }}
            >
              Delete
            </button>
            {threadID ? (
              <button type="button" className="link" onClick={() => model.openThreadFromNotification(threadID)}>
                Open report
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RoutineRunLine({ run }: { run: RoutineRunInfo }) {
  const at = format.parseISO(run.at);
  return (
    <div className="routine-run">
      <div className="routine-meta">
        {[OUTCOME_LABEL[run.outcome], at ? format.stamp(at) : null, `${run.tokens.toLocaleString()} tokens`]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {run.summary ? <div className="routine-meta tertiary">{format.preview(run.summary, 200)}</div> : null}
    </div>
  );
}
