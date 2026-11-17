# Architecture

Two-minute orientation. The canonical plan is
[`blueprint-v3.html`](blueprint-v3.html); where this file and the blueprint
disagree, the blueprint wins for intent, and the code wins for current
behaviour.

## What the product is

**Agni Bot** is a messaging app for bots. The owner talks to named, specialised
bots, each with its own role and memory, in one continuous conversation per
bot. The app values performance over UI polish. The project is
source-available and free for non-commercial use (`LICENSE.md`).

## Shape

```
Web app (React)  ───┐
Mac app (SwiftUI) ──┤
Tauri app (planned)─┼── WebSocket (typed frames, seq'd, resumable) ── over Tailscale
CLI (apps/cli)  ────┘                                                │
                                                                     ▼
                                                      apps/server  (Bun + TypeScript)
                                                      ├─ ws: server / dispatch / frame log
                                                      ├─ agent: bots (personas), task lane,
                                                      │         creation, visibility
                                                      ├─ policy: one gate for every tool call,
                                                      │          spend caps, pause, audit log
                                                      ├─ jobs: queue runner + turn kind
                                                      │        (daemon work while idle)
                                                      ├─ models: router → Groq · Cerebras ·
                                                      │           NIM · Gemini · OpenRouter ·
                                                      │           LM Studio, plus a ChatGPT
                                                      │           subscription source (free-first,
                                                      │           failover before first token)
                                                      ├─ plugins: catalog (Gmail, Calendar, Drive,
                                                      │           MCP connectors), OAuth, credentials
                                                      ├─ secrets: encrypted vault, redaction
                                                      ├─ stores: SQLite (WAL) + FTS5 (see Stores)
                                                      └─ tools: registry (schema + timeout),
                                                                bounded memory, links, tasks, mail,
                                                                web, files, approvals
```

Planned, not built: an ACP bridge for coding jobs (P3), a Tauri client
(`apps/app`, README only), and messaging integrations such as Slack and Discord.

### Clients

- `apps/web` is a React + Vite client. It uses the transport-agnostic core in
  `packages/client` (frame codec, connection loop, resync, conversation reducer,
  settings, health). Its screens have addresses (`/agent/<id>`, `/group/<id>`,
  `/task/<id>`, `/tasks`, `/settings`), and `apps/web/src/state/router.ts`
  maps them to screens.
- `apps/mac` is a SwiftUI client. `AgniKit` is its own Swift connection and
  conversation layer, and `AgniProtocol` mirrors the frames by hand.
- Both speak `packages/protocol` version **2**. A frame change lands in
  `packages/protocol` first, then flows to each client.

## Process lifecycle

`bun run serve` is the server entry point. `bun run daemon start` spawns that
same command detached (own session, stdio → the log file), writes a pid file,
and reports success once `/health` answers. `daemon stop` is SIGTERM (SIGKILL
only if the process refuses to die). `serve` handles both signals by stopping
the job runner, flushing the frame log, and closing SQLite. Log and pid
locations default to `~/.agni/` (see `apps/server/src/config.ts`). The
provider settings file, `providers.json`, also defaults to `~/.agni/`
(`apps/server/src/models/providers.ts`). An older copy under the repo's `data/`
folder is moved there on first run (`apps/server/src/home.ts`).

At start, `serve` opens the vault before it reads its settings, so providers see
their keys (`apps/server/src/startup/s3-vault.ts`). A vault that exists but cannot
be opened stops the start with a message. The server never falls back to
plaintext keys.

The local server answers only the `Host` and `Origin` names it expects. Every
route needs a paired device except the app shell, pairing, `/health`, the
WebSocket handshake, the OAuth callback and share links. See
[`protocol.md`](protocol.md), "Who may connect".

## Background jobs

The `jobs` table is the queue: `queued → running → done | failed`. Claims are
transactional, attempts are counted, and a job a dead process left `running` is
requeued at boot. One runner per daemon works the queue on a pool of
`AGNI_JOB_CONCURRENCY` workers (default 2). Only `turn`, `routine`, and
`task.reminder` jobs may overlap with themselves. Every other kind runs one at
a time (`apps/server/src/jobs/runner.ts`).

The `turn` kind runs one prompt in a thread. The daemon uses it for reminders
and scheduled briefs, and it streams results to any connected client. Completion
raises `notify`. A `turn` job with `everyMs` reschedules itself and keeps its
thread. Failures retry with backoff, then park as `failed` with a notification.

A paused bot, or a bot turned off, starts no new work. Its scheduled jobs that
come due are skipped and recorded as `skipped (paused)` or `skipped (bot off)`.
They do not run late when the bot is resumed. Task reminders keep running during
pause-all. Housekeeping that calls a model waits until the pause ends. The runner
checks the pause state when it claims a job, so a pause takes effect on the next
claim.

Background results land in the bot's conversation as a `background` session
block. They join the transcript without stealing the active chat block.

Live and background turns share a process-wide model stream limit
(`AGNI_MAX_CONCURRENT_TURNS`). Chat turns that arrive at capacity receive
`server_busy` and can retry. `/health` reports active and configured capacity.
Queue and replay state are process-local, and SQLite is the single-writer store,
so one daemon scales vertically. Horizontal replicas would need shared
coordination and a multi-writer database.

## The one contract

`packages/protocol` defines every frame, validated with zod. The server assigns
a monotonic `seq` to every outbound frame and keeps a bounded replay log.
Clients that reconnect send `resync {lastSeq}`. If they fall behind the log,
they get `resync_gap` and reload from the database. See [`protocol.md`](protocol.md).

## Speed rules (why this stays fast)

- **S1 constant prompt**: system + persona + the last 16 messages, hard cap.
  Nothing grows with history (`agent/task-loop.ts`).
- **S2 memory is a tool**: FTS5 indexes (memories, links) are read by tools on
  demand, never injected into the prompt prefix.
- **S3 one lane**: every turn, chat or background job, runs the task lane
  (`runTaskTurn`). The separate one-call instant lane was removed.
- **S4 write-time work**: summaries and indexes are written when data lands,
  not at read time. Scheduled work lives in the job queue.
- **S5 warm path**: router health and cooldown avoid paying timeouts twice.
- **S6 perceived speed**: local echo and streaming deltas on the client.
- **S7 bounded everything**: per-turn timeout, first-token timeout, step budgets
  in the task runner, and spend caps checked before every model call (see
  Policy gate below).

## Task lane

Every turn runs through `agent/task-loop.ts`, including background jobs.
Each task step sends the same system prompt
and tool schemas first, then the compacted session and recent messages. That
keeps the request prefix stable for provider-side caching.

The loop is bounded in four ways:

- A model response may ask for at most 25 tool calls. Calls past that point are
  skipped, and the model is told so.
- Each chat step asks for at most 8,192 output tokens, unless
  `AGNI_MAX_OUTPUT_TOKENS` sets another limit.
- A chain of handoffs and delegations is capped at 48 steps, or 24 when
  delegated (`agent/guardrails.ts`).
- The turn timeout (`AGNI_TURN_TIMEOUT_MS`, default 120000) ends any turn that runs too long.

The loop persists its message log
and each tool result. An interrupted session restores saved tool results. Calls
with an uncertain outcome come back as errors and are never replayed
automatically. Each tool call goes through the policy gate before it runs.
Approval decisions are stored in SQLite and resolve the active loop through the
approval broker (`agent/approval-broker.ts`).

A turn that runs out of budget still answers, naming the work that happened.
A turn that only reads the app's own source is told to act, then stopped with
the truth about what it can and cannot do.

Scheduling is a tool. `job_schedule` puts a prompt on the queue with a
wall-clock schedule, `job_list` shows what is queued, and `job_cancel` stops it.

Redefining a bot is also a tool. `update_agent` writes the owner's words into
the bot's role and prompt, and `create_agent` gives a new bot its own allowlist
and role. Both survive a restart: the roster is rebuilt from the `agents` rows at boot.

A handoff lands in the *asked* bot's conversation, so opening that bot shows the
delegated work.

## Policy gate

Every tool call is decided once, by `decide()` in
`apps/server/src/policy/engine.ts`. The checks run in this order. The first one
that answers ends the question:

1. **Pause.** The owner has paused everything, or this bot is off.
2. **Capability.** The tool is this bot's, is registered, and is loaded.
3. **Schema.** The arguments are well formed.
4. **Resources.** A routine's domain list, and anything the owner already refused in this run.
5. **Budget.** Spend caps and run limits still have room.
6. **Tier and taint.** What the call does, and whether the run has read outside content.
7. **Stored rules.** An "always allow" that matches this bot, this tool and this target.
8. **Owner.** A card asks, and the call waits for the answer.

Each tool declares its class (untrusted-reader, private-reader, effector or
inert), its tier (0 to 3), and what it touches (`policy/metadata.ts`). MCP tools get tier 2 unless
the owner trusts them. A test fails when a registered tool has no metadata.

A run is **tainted** once it reads outside content: a web page, mail, or the
output of another bot (`policy/context.ts`). In a tainted run:

- a send asks the owner, and the card names the untrusted source;
- a fetch to a host the owner did not name asks;
- the run cannot change bots, routines, jobs, skills, rules or MCP setup;
- stored "always allow" rules do not apply, and nothing new is remembered.

The agent's own mailbox and calendar are free only in an untainted run. A
refusal covers the thing refused, not just the tool, for the rest of the run
(`policy/denials.ts`). Taint and limits carry into delegated work
(`policy/narrowing.ts`).

Spend caps (`policy/budget.ts`) are checked before every model call. The
router writes one ledger row for each completed call, background calls
included (`models/usage-hook.ts`, `apps/server/src/startup/s2-ledger.ts`). Prices
and the date each came from are in `models/prices.ts`. The defaults are $2 a
day across all bots, $1 a day for one bot, and $0.50 per job. A check that
cannot read its state stops the call. It fails closed.

Run limits (`stores/policy-settings.ts`) bound one run: 30 minutes of run time,
not counting time spent waiting for the owner; 4 delegations at once; 10
self-scheduled jobs per bot; and 10 wakes per request.

Every decision, approval, taint change, pause and cap change is written to the
audit log (`stores/audit.ts`, table `audit_events`). Each row carries the hash
of the row before it. `agni audit verify` recomputes the chain.

## Failure honesty

- Failover happens only **before** the first token reaches the client. A stream
  that dies mid-flight ends the turn (`MidStreamError` → `turn.end{error}`)
  instead of duplicating text from a second provider.
- Partial output is persisted even when a turn is cancelled or times out. The
  `stop_reason` column records what happened.
- A client that falls behind the replay log gets `resync_gap` and reloads from
  the database, which always holds the durable message history.

## Stores

One SQLite database in WAL mode. Its location comes from `AGNI_DB_PATH`
(default in `config.ts`). Tables are created by numbered migrations. The base
list in `apps/server/src/db/migrations.ts` has ids 1 to 53. Migrations 54 to 59
and 65 are in `db/s2/`, and migrations 60 to 64 are in `db/s3/`. They add the
policy settings, cost columns on the usage ledger, the audit log, the pause
state, run clocks and denials, MCP tool pins, OAuth states, and vault references
for plugin credentials. Migration 63 paused any routine that held model-written
SQL. `openDatabaseForCLI` refuses to run until every listed migration is
applied. Main groups:

- Conversations and turns: `conversations`, `threads`, `turns`, `messages`,
  `channels`, `channel_messages`, `summaries`, `attachments`, `artifacts`
- Bots and memory: `agents`, `agent_memories`, `memories`, `memory_conflicts`,
  `links`, plus FTS5 indexes
- Work: `tasks`, `task_lists`, `task_activity`, `jobs`, `forms`, `approvals`,
  `approval_rules`, `peer_chains`
- Policy and audit: `policy_settings`, `pause_state`, `audit_events`,
  `run_denials`, `run_clocks`, `run_clock_waits`
- Usage and plugins: `usage_ledger` (with cost and cached tokens),
  `plugin_connections`, `mcp_tool_pins`, `oauth_states`
- Devices and appearance: `devices`, `appearance_*`

A conversation is the one chat with a bot, never reset. Every `threads` row is
a session block inside it. A session block is an invisible context span that
opens with the carried summary and closes into it (`closed_by`: `manual`,
`context`, or `background`). Compaction is write-time: one bounded model call per
closing block (`agent/rollover.ts`). A failed summary carries the previous
summary forward and never blocks a turn.

## Secrets, redaction and the audit log

- **Vault.** `apps/server/src/secrets/` keeps provider keys, plugin credentials
  and ChatGPT accounts in `vault.bin` (AES-256-GCM). The vault's 32-byte data
  key sits in the operating system's keystore (`bun-secrets`), or in a
  passphrase file on a headless Linux server. Where no keystore is usable,
  `agni setup` uses file mode. Secrets then stay in `config.env` and
  `plugins.json`, readable only by the owner. `agni doctor` shows the mode.
  Registered migrators move old plaintext into the vault
  (`apps/server/src/credentials/register.ts`, `secrets/migrate.ts`).
  `agni vault export --yes` writes the values back to plaintext.
- **Redaction.** `util/redact.ts` keeps a registry of secret values. Each value
  has a holder, such as a vault entry or an environment variable. Log lines and
  outgoing frames are masked against that registry. Stored text is masked when it
  goes through `redactForStorage` (`util/redact-storage.ts`), and not every store
  does yet. Routine run records, job and task results, task activity and
  summaries are still written without redaction, and so are some channel
  messages and tool records. Treat them as able to hold a secret.
- **Child processes.** Shell tools and the PDF worker get a fixed environment
  and `PATH` (`util/child-env.ts`). The server picks their working directory, and
  their whole process tree is ended with them (`util/process-tree.ts`). This is
  hygiene, not isolation. A child running as the same user can still read the
  server's memory or environment. A sandbox is planned and not built.
- **Audit.** Described under Policy gate. `agni audit verify` exits 1 when a
  row has been changed.

## Plugins

The catalog in `apps/server/src/plugins/catalog.ts` lists what can be connected,
per account, with the scopes it asks for and the capability policy:
`free` (runs without asking), `approval` (asks first), or `off` (refused).
Current entries are Agni's Gmail, the owner's Gmail, Agni's Calendar, the
owner's Calendar, the owner's Drive, and the connectors Granola, Firecrawl,
and Notion. MCP tools are pinned to the definition the owner approved, and
MCP server URLs are checked for private addresses before each connect.
See [`plugins.md`](plugins.md).

## Home

This Mac now; bb-1 later (systemd or compose, Tailscale, same image, SQLite
backup). The server binds to `AGNI_HOST` only. Loopback in dev, the Tailscale
interface on bb-1. Nothing listens on the public internet.
