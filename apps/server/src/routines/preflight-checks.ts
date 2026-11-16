/**
 * Named routine pre-checks (S3-09).
 *
 * A routine's pre-check answers one question cheaply: "has anything changed
 * since the last run?" Until now a model wrote that question as SQL. Model text
 * is untrusted input, so the question now comes from this fixed list: each
 * check is a constant statement with `?` placeholders, chosen by name, with
 * typed parameters validated before they are bound. Nothing a model writes ever
 * becomes SQL. Adding a check means adding an entry here, in code review.
 */

export type CheckValue = string | number;

/** What a stored or tool-created routine holds: a check chosen by name. */
export interface CheckPreflight {
  kind: "check";
  name: string;
  params: Record<string, CheckValue>;
}

type ParamSpec =
  /** An identifier: letters, digits, `_` and `-`, at most 64 characters (agent, list and job-kind ids). */
  | { type: "id"; required: boolean; about: string }
  | { type: "int"; min: number; max: number; default: number; about: string };

export interface CheckEntry {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** One read-only statement, no interpolation: values only ever arrive through `?`. */
  sql: string;
  /** The `?` values, in order, from validated parameters. */
  bind(params: Record<string, CheckValue>, now?: number): Array<CheckValue | null>;
  /** A valid parameter set, for tests and tool schemas. */
  sampleParams(): Record<string, CheckValue>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function entry(spec: Omit<CheckEntry, "sampleParams">): CheckEntry {
  return {
    ...spec,
    sampleParams() {
      const sample: Record<string, CheckValue> = {};
      for (const [key, param] of Object.entries(spec.params)) {
        if (param.type === "id") {
          if (param.required) sample[key] = "sample";
        } else sample[key] = param.default;
      }
      return sample;
    },
  };
}

export const PREFLIGHT_CHECKS: readonly CheckEntry[] = [
  entry({
    name: "thread_activity",
    description: "Changed when a bot's conversations get a new message (count and newest time of its messages).",
    params: { agentID: { type: "id", required: true, about: "the bot's id" } },
    sql: "SELECT COUNT(*) AS messages, MAX(m.created_at) AS latest FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.agent_id = ?",
    bind: (params) => [params.agentID!],
  }),
  entry({
    name: "agent_memories",
    description: "Changed when a bot's memories are added or edited (count and newest update time).",
    params: { agentID: { type: "id", required: true, about: "the bot's id" } },
    sql: "SELECT COUNT(*) AS memories, MAX(updated_at) AS latest FROM agent_memories WHERE agent_id = ?",
    bind: (params) => [params.agentID!],
  }),
  entry({
    name: "open_tasks",
    description: "Changed when open tasks are added, finished or edited, optionally in one list.",
    params: { listID: { type: "id", required: false, about: "limit to one task list" } },
    sql: "SELECT COUNT(*) AS open, MAX(updated_at) AS latest FROM tasks WHERE status = 'open' AND (? IS NULL OR list_id = ?)",
    bind: (params) => [params.listID ?? null, params.listID ?? null],
  }),
  entry({
    name: "pending_approvals",
    description: "Changed when an approval is waiting for the owner (count and newest request time).",
    params: {},
    sql: "SELECT COUNT(*) AS pending, MAX(created_at) AS latest FROM approvals WHERE status = 'pending'",
    bind: () => [],
  }),
  entry({
    name: "failed_jobs",
    description: "Changed when a background job fails, optionally for one kind of job.",
    params: { kind: { type: "id", required: false, about: "limit to one job kind, e.g. routine" } },
    sql: "SELECT COUNT(*) AS failed, MAX(updated_at) AS latest FROM jobs WHERE state = 'failed' AND (? IS NULL OR kind = ?)",
    bind: (params) => [params.kind ?? null, params.kind ?? null],
  }),
  entry({
    name: "new_turns",
    description: "Changed when a bot has run turns in the last N hours (count and newest start time).",
    params: {
      agentID: { type: "id", required: true, about: "the bot's id" },
      hours: { type: "int", min: 1, max: 720, default: 24, about: "how far back to look" },
    },
    sql: "SELECT COUNT(*) AS turns, MAX(started_at) AS latest FROM turns WHERE agent_id = ? AND started_at >= ?",
    bind: (params, now = Date.now()) => [params.agentID!, new Date(now - Number(params.hours) * 3_600_000).toISOString()],
  }),
];

/** The checks as data, for a tool schema or a help text. */
export function describeChecks(): Array<{ name: string; description: string; params: Record<string, { type: string; required: boolean; about: string }> }> {
  return PREFLIGHT_CHECKS.map((check) => ({
    name: check.name,
    description: check.description,
    params: Object.fromEntries(
      Object.entries(check.params).map(([key, spec]) => [key, { type: spec.type, required: spec.type === "id" ? spec.required : false, about: spec.about }]),
    ),
  }));
}

export function findCheck(name: string): CheckEntry | undefined {
  return PREFLIGHT_CHECKS.find((check) => check.name === name);
}

/**
 * Validate a pre-check chosen by name and return it in its normal form (every
 * default filled in, so the same question always hashes the same). Throws a
 * message the model or the owner can act on.
 */
export function parseCheckPreflight(input: unknown): CheckPreflight {
  if (typeof input !== "object" || input === null) throw new Error('preflight must be an object like { "kind": "check", "name": "pending_approvals" }');
  const raw = input as { kind?: unknown; name?: unknown; params?: unknown };
  const names = PREFLIGHT_CHECKS.map((check) => check.name).join(", ");
  const check = typeof raw.name === "string" ? findCheck(raw.name) : undefined;
  if (!check) throw new Error(`unknown check ${JSON.stringify(raw.name)}; choose one of: ${names}`);
  const given = raw.params === undefined ? {} : raw.params;
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error(`${check.name}: params must be an object`);
  const values = given as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!(key in check.params)) throw new Error(`${check.name}: unknown parameter ${JSON.stringify(key)}`);
  }
  const params: Record<string, CheckValue> = {};
  for (const [key, spec] of Object.entries(check.params)) {
    const value = values[key];
    if (spec.type === "id") {
      if (value === undefined || value === null) {
        if (spec.required) throw new Error(`${check.name}: ${key} is required (${spec.about})`);
        continue;
      }
      if (typeof value !== "string" || !ID.test(value)) throw new Error(`${check.name}: ${key} must be an id of letters, digits, _ or -, up to 64 characters`);
      params[key] = value;
    } else {
      const number = value === undefined ? spec.default : value;
      if (typeof number !== "number" || !Number.isInteger(number) || number < spec.min || number > spec.max) {
        throw new Error(`${check.name}: ${key} must be an integer from ${spec.min} to ${spec.max}`);
      }
      params[key] = number;
    }
  }
  return { kind: "check", name: check.name, params };
}
