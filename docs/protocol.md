# Wire protocol v2

The contract between the server and every client (Mac app, Android app, CLI).
Machine version: [`packages/protocol/src/frames.ts`](../packages/protocol/src/frames.ts) —
if the two disagree, the code wins, then fix this doc.

## The conversation model (v2)

One **conversation** per agent is the user-facing chat: a single enduring
transcript, like texting a person. A **session block** is an invisible span of
context inside it — the model's working memory between boundaries. Blocks
close on `/new` (`manual`), when context pressure says so (`context`), or when
background work lands as its own block (`background`); each closing block is
compacted into a bounded carried summary that the next block opens with. The
`thread` frames stay for the CLI; clients built on the conversation model
never reason about thread ids.

## Envelope

- One WebSocket per client: `GET /ws` (HTTP upgrade). The upgrade is refused
  (403) when the `Host` or `Origin` header is not one the server answers to
  (see "Who may connect" below); native clients send no `Origin`. The first
  frame must be `hello`; every other frame before auth gets
  `error {code:"unauthorized"}`.
- Frames are JSON text. Client frames carry no sequence number. **Every**
  server frame carries `seq`: a positive, monotonically increasing integer
  assigned by the server. Exception: `error` frames go only to the
  connection that caused them and reuse the current `seq` without advancing
  it, so they never take a replay slot.
- A client that misses frames reconnects and sends `resync {lastSeq}`; the
  server replays every frame after `lastSeq`. If the gap is older than the
  bounded replay log, the client gets `error {code: "resync_gap"}` and reloads
  state from the server's durable storage.
- Handshake: connect → `hello {v, token, device}` → `hello.ok` +
  `agents.update`. `hello.ok` answers the connecting socket only and is not
  part of the replay log. The server closes connections that don't complete
  the handshake within `AGNI_HELLO_TIMEOUT_MS` (code 4001), on version mismatch
  (4002), or on a bad token (4003).
- `lastSeq` in `hello.ok` is the server's current sequence; a client whose own
  `lastSeq` is higher (server crash + restart) must treat the difference as a
  gap and reload.

## Who may connect

Two exact checks run on every HTTP request and on the WebSocket upgrade. There
is no "any loopback" and no wildcard.

- **Host.** The `Host` header must name this server: the bind address
  (`AGNI_HOST`), the loopback names (`127.0.0.1`, `localhost`, `[::1]`) when it
  is bound to loopback or a wildcard address, or the host of an allowed origin
  below. Anything else is `403 forbidden host`, before any route runs. This
  stops DNS-rebinding pages, which reach the server under their own name.
- **Origin.** Browsers send `Origin`; native clients (Mac, CLI) send none and
  skip this check. An `Origin` must be one of: the server's own origin;
  `AGNI_PUBLIC_ORIGIN` (the https name a proxy such as `tailscale serve`
  publishes); an entry of `AGNI_ALLOWED_ORIGINS` (comma-separated http or https
  origins such as `http://192.168.1.9:8787`; paths and junk are dropped); or,
  only when `AGNI_DEV=1` and the server is bound to loopback, the Vite dev
  server at `http://127.0.0.1:5173` or `http://localhost:5173`. Any other
  origin is `403 forbidden origin`. CORS answers echo the request's own origin
  when allowed and never `*`, except `GET /health` (below).
- **`AGNI_DEV`.** `1` turns on the Vite dev-server trust above and nothing
  else. It is off in a normal install, so whatever else serves port 5173 on the
  machine cannot ride the owner's session.

At boot the server logs when the bind address would lock browsers out (a
wildcard or non-loopback bind with neither `AGNI_PUBLIC_ORIGIN` nor
`AGNI_ALLOWED_ORIGINS` set).

### `GET /health` tiers

`/health` answers any origin so a web client can tell the daemon is up before it
pairs, so what it returns depends on who asks.

- **Not paired** (no `Authorization: Bearer <device token>` and no session
  cookie, or a token that is revoked or unknown): liveness only,
  `{ok, v, serverTime, uptimeMs}`.
- **Paired device** (bearer token or the paired browser's cookie): the same plus
  `seq`, `providers`, `usageToday` and `modelCapacity`. The cross-origin CORS
  headers do not allow `Authorization`, so the full report is read same-origin
  or by a native client.

`agni daemon status` sends the device token in `AGNI_TOKEN` (from the
environment or `config.env`) when one is set, and prints "details need a paired
device" when it gets liveness only.

### Share links

`thread.export` publishes a self-contained HTML file at `GET /share/<token>`
(the token is 32 hex characters and is the only access control).

- A link works for **7 days** from publish. Expired files are deleted at boot.
- `DELETE /share/<token>` revokes it at once. It needs a paired device (bearer
  token or cookie, else `401`) and an allowed `Origin` (else `403`), and answers
  `{ok: true}`; an unknown token answers `404`.
- An expired, revoked or never-issued link all answer the same `404`
  ("This export no longer exists."), so a stale token reveals nothing.

### Input limits

`msg.send` accepts at most **100,000 characters** in total (`text`, or every
part of `texts` together). A longer message is refused before anything is stored
or echoed with `error {code: "bad_frame"}` whose message names the limit, so a
client can show it and keep the draft.

## client → server

| Frame | Payload | Notes |
| --- | --- | --- |
| `hello` | `{v, token?, device}` | First frame. `v` is the protocol version. `token` may be left out only when a paired browser's `agni_session` cookie authenticated the socket upgrade. |
| `resync` | `{lastSeq}` | Replay everything after `lastSeq`. |
| `msg.send` | `{threadID?, text, files?, conversationID?, channelId?, toAgentId?, texts?}` | Channel clients target a channel (default `main`) and may address an agent. `texts` batches multiple bodies; legacy clients continue to send `text`. A message sent while its thread is mid-turn is queued and runs when the turn ends; `stop` (or `cancel`, `never mind`) is a control message that interrupts that turn instead. While a new primary bot is waiting for its first name, a short one-line message in `main` (up to three words, no trailing `?` or `!`) is taken as the name: it is stored and echoed as the owner's message, then `agent.updated` follows. Any other message is an ordinary message and the bot stays unnamed. The whole message is limited to 100,000 characters (see "Input limits"). |
| `user.typing` | `{channelId?, isTyping}` | Extends server-side message coalescing while the user is typing. |
| `agent.rename` | `{agentId, name}` | Renames an agent and completes primary-agent onboarding. |
| `agent.profile` | `{agentId, role?, visibility?, model?, critic?}` | Edits an agent's profile from the app: `role` is the tag the roster shows ("chief of staff"), `visibility` is what other agents may see of its work (`private \| summary \| shared`), `model` is the bot's own model (`provider`, `provider:model` or a model id; `null` or `""` clears it), which the router tries first and falls back from when that provider is unavailable. `critic` (opt-in) names another bot that reviews this bot's email drafts before the approval card; its notes ride on the card. `null` or `""` turns it off. At least one field is required. The answer is an `agent.updated` carrying the new `role` and `visibility`; the same change the `update_agent` chat tool makes, so the two cannot drift apart. |
| `agent.create` | `{name, prompt, role?, id?, color?}` | Creates an agent from the app's roster — the "+" button. `prompt` is its system prompt, `role` its tag. The same creation the `create_agent` chat tool performs, so a bot made here and a bot made in chat are the same kind of thing; the roster comes back in an `agents.update`. |
| `push.subscribe` | `{subscription: {endpoint, keys: {p256dh, auth}}}` | Stores this device's Web Push subscription (replacing any for the same endpoint). The server pushes a `notify` there only when no authed socket is connected. APNs for the Mac app is not built. |
| `push.unsubscribe` | `{endpoint}` | Drops that subscription. |
| `push.vapid.get` | `{}` | Asks for the VAPID public key; answer: `push.vapid`. |
| `agent.proactivity` | `{agentId, quietStart?, quietEnd?, maxPerDay?}` | Per-bot quiet hours (`"HH:MM"`, server time zone; both or neither, `null` clears) and a cap on unprompted pushes per local day (`null` removes it). Held messages still land in the transcript; only the push and sound are held. Always answered with the current values as `agent.proactivity`, so an empty set reads them. |
| `channel.create` | `{name, agentIds}` | Phase 4. Creates a group channel: the owner and 2–8 bots. The first id is the primary bot. Answered (to every client) by `channel.created`. |
| `channel.list` | `{}` | Phase 4. The group channels; answered by `channel.list.ok`. |
| `channel.history` | `{channelId, limit?}` | Phase 4. A group channel's messages, last N chronological (default 200, max 500); answered by `channel.history.ok`. |
| `form.answer` | `{requestID, answer}` | The owner answered a question the agent asked — the option they chose, or their own words if they typed instead of choosing. The answer lands on the `forms` row and the turn waiting on it carries on with it. |
| `msg.cancel` | `{turnID}` | Interrupts the turn: providers abort, partial output is kept. When no turn with that ID is running (it already finished, never existed, or the server restarted) the asker gets an `error` with code `not_running`; the client can treat it as "already finished". Additive in v2. |
| `approve.reply` | `{requestID, decision}` | `decision`: `once \| always \| reject`. |
| `secret.reply` | `{requestID, value}` | The owner's one-time password for a `secret.request`. Consumed server-side; never persisted, replayed, logged, or sent to the model. |
| `secret.cancel` | `{requestID}` | Dismisses a pending secret prompt; the waiting tool fails as cancelled. |
| `agent.select` | `{agentID}` | Sets the persona for subsequent `msg.send` on this connection. |
| `conversation.open` | `{conversationID, agentID?}` | Resolves (creating when missing) the agent's conversation. Empty `conversationID` + `agentID` selects that agent's. Answer: `conversation.ok`. |
| `session.new` | `{conversationID}` | Closes the active session block (`manual`), compacts it into the carried summary, continues in a fresh block; emits `session.start`. |
| `conversation.history` | `{conversationID, limit?}` | The full transcript across blocks, last N chronological (default 50, max 500); each message carries its `sessionID`. |
| `thread.open` | `{threadID}` | Pins the session's active thread (CLI). Silent; history comes via `resync`. |
| `thread.export` | `{conversationID, title?}` | Render the conversation to one self-contained HTML file and answer with `thread.export.ok`. The daemon renders, not the client, so the artifact is identical everywhere; the file holds messages, tool calls, model reasoning, and approval decisions. |
| `thread.list` | `{limit?}` | Recent threads, newest first (default 20, max 200). |
| `thread.history` | `{threadID, limit?}` | Durable messages, last N chronological (default 50, max 500). |
| `job.list` | `{limit?}` | Tasks and routines, newest/next due first. |
| `job.set` | `{jobID, action}` | `action`: `pause \| resume \| run`. Answered by a fresh `job.list.ok`; `run` on a job that is already running queues nothing and answers an `error` with code `already_running` instead. |
| `job.delete` | `{jobID}` | Deletes a task unless it is running; replies with a refreshed `job.list.ok`. |
| `approval.rules.list` | `{}` | The standing "Always allow" rules, newest first. Answered by `approval.rules.list.ok`. Additive in v2. |
| `approval.rule.revoke` | `{id}` | Revokes one rule; it never matches again. Answered by `approval.rule.revoke.ok`, or by an `error` with code `not_found` when the id is unknown or already revoked. Additive in v2. |
| `approval.full` | `{requestID}` | The whole text behind an approval card marked `truncated` (`approval.request.truncated` is true): one whose preview was cut, or one too long to take in at a glance (over 2,000 characters or 40 lines). For a long card that is not cut the text is the whole preview the card was raised with; for a cut one it is the call as the turn stored it. Answered by `approval.full.ok`, or by an `error` with code `not_found` when the card is gone. Additive in v2. |
| `policy.pause` | `{paused?, agentID?}` | Pause or resume every bot: `paused: true` stops running work and starts nothing new, `false` resumes (a bot that was turned off stays off). Omit `paused` to only read the state. With `agentID` it means that one bot, the same as `agent.enabled.set` with `enabled: !paused`. Answered by a broadcast `policy.pause.ok`. Additive in v2. |
| `agent.enabled.set` | `{agentID, enabled}` | Turn one bot off or on. Off stops that bot's running turns, skips its scheduled jobs, and refuses new messages to it (`agent_off`). Answered by a broadcast `policy.pause.ok` and a fresh `agents.update`. An unknown bot answers `unknown_agent`. Additive in v2. |
| `spend.status` | `{}` | Today's spend against the caps. Answered by `spend.status.ok`. Additive in v2. |
| `spend.caps.set` | `{dayUsd?, perBotDayUsd?, perJobUsd?}` | Change the spend caps: a number of dollars above zero, or `null` for no cap; a field left out keeps its value. Answered by a broadcast `spend.status.ok`, or by an `error` with code `bad_cap` (a bot's cap above the daily cap, or an unusable number). Additive in v2. |
| `spend.continue` | `{runKey}` | Owner only: let a run that a spend cap stopped go on, once. `runKey` is the one `spend.stopped` named. Adds one allowance (the per-task cap, or $0.50 when that is off) for that run and that cap only; the limit itself does not change. Answered by `spend.continue.ok`, or by an `error` with code `not_found` when that run was not stopped (or the server restarted since). The run does not restart by itself: the next message, or the job's retry, goes through. Recorded in the audit log. Additive in v2. |
| `task.list` | `{status?, limit?}` | Lists durable tasks and task lists; status is `open \| done \| snoozed \| all`. |
| `task.create` | `{title, description?, dueAt?, deadlineAt?, reminderAt?, labels?, repeatRule?, priority?, listID?, parentTaskID?, attachmentIDs?}` | Creates a task or subtask, optionally with a schedule, deadline, labels, repeat cadence and uploaded files. |
| `task.list.create` | `{name}` | Creates a task list and returns the current list navigation data. |
| `task.activity` | `{taskID}` | Reads the task's recent edit and status history. |
| `task.update` | `{taskID, action, until?, title?, description?, dueAt?, deadlineAt?, reminderAt?, labels?, repeatRule?, priority?, listID?}` | Completes, reopens, snoozes, or edits a task. |
| `task.answer` | `{taskID, questionID, text}` | Answers a question a delegated task asked. Its own frame, not a `msg.send`: the task must be in `needs_input`, the answer belongs to one question, and it is accepted exactly once. |
| `bind.direct` | `{agentID}` | Pins this client to an agent: the server resolves that agent's conversation, its active session block and its DM channel, and answers with them. |
| `provider.add` | `{providerID, apiKey, model?, baseUrl?, label?}` | Adds a supported API provider over the authenticated socket. `providerID: "custom"` adds an endpoint of the owner's own: `baseUrl` is an OpenAI-compatible base (`https://host/v1`), `label` names it in the list. The daemon stores the key in its mode-600 `.env` and the endpoint in `data/providers.json`; neither is ever returned. |
| `provider.model.set` | `{providerID, model}` | Changes a configured provider's model ID on the daemon and updates the live router. |
| `provider.auth.status` | `{providerID: "chatgpt"}` | Reads public ChatGPT connection/account metadata. Requires device authentication. |
| `provider.auth.start` | `{providerID: "chatgpt", accountID?}` | Starts official OAuth on the daemon host with a loopback callback, fresh PKCE/state/nonce. A saved account ID reuses its registration. Requires a local authenticated connection. |
| `provider.auth.cancel` | `{providerID: "chatgpt", loginID}` | Cancels the initiating device's pending login. |
| `provider.auth.select` | `{providerID: "chatgpt", accountID}` | Selects a saved connected account after loading its eligible model catalog. |
| `provider.auth.acknowledge` | `{providerID: "chatgpt", accountID}` | Persists dismissal of the first-sign-in ChatGPT plan notice for the selected registration. |
| `provider.auth.disconnect` | `{providerID: "chatgpt", accountID}` | Aborts active ChatGPT requests, clears local tokens, and attempts remote revocation. Keeps registration metadata for later sign-in. |
| `plugin.list` | `{}` | The plugin catalog bound to accounts (see below); answer: `plugin.list.ok`. |
| `appearance.list` | `{}` | Read the owner's named appearance profiles and active profile. |
| `appearance.save` | `{profile, activate?}` | Validate and upsert a versioned appearance profile; activates it unless `activate` is false. |
| `appearance.activate` | `{id}` | Select an existing profile for every connected client. |
| `appearance.delete` | `{id}` | Delete a named profile. |
| `plugin.connect` | `{pluginID, account}` | Begin connecting `pluginID` to `account` (`agent` = Agni's own, `owner` = the user's). OAuth kinds answer `plugin.connect.ok` with an authorize URL to open in the system browser; MCP kinds are not connectable until their server pass lands. |
| `plugin.configure` | `{pluginID, account, user?, pass?, key?, url?, clientID?, clientSecret?}` | Gives a plugin its credentials and connects it in one step. `app-password` kinds take `user` + `pass`; `api-key` kinds take `key` and/or `url`; `oauth` kinds take the Google `clientID` + `clientSecret`. The daemon writes them to its mode-600 `plugins.json` and answers `plugin.connect.ok` (with an authorize URL for OAuth). |
| `plugin.disconnect` | `{connectionID}` | Revokes the connection (server-side tokens deleted, Google revoke called); answers and fans out the refreshed snapshot. |

## Plugins

A plugin row binds one catalog entry to one account role. `capabilities` is
the owner's policy grid — `free` (no approval), `approval` (asks first), or
`off` (refuses) — and lives entirely server-side in plugin capability
policies; OAuth **scopes** (what Google granted) are separate from what the
server then allows the agent to do with them. Wrapped-form actions opened in a
browser complete back at the daemon's loopback redirect
(`/oauth/callback`):

| Frame | Payload | Notes |
| --- | --- | --- |
| `plugin.list.ok` | `{plugins: [PluginInfo]}` | Answer to `plugin.list` / `plugin.disconnect`; addressed to the requester, not replayed. |
| `appearance.list.ok` | `{profiles, activeID}` | Requester-only answer containing the current appearance library. |
| `appearance.updated` | `{profiles, activeID}` | Replayable appearance-library change broadcast to paired clients. |
| `plugin.connect.ok` | `{pluginID, account, authorizeURL}` | Open `authorizeURL` in the system browser; `null` when nothing is needed. |
| `plugin.state` | `{plugins: [PluginInfo]}` | Replayable snapshot emitted whenever a connection changes (browser callback landed, expired, errored, disconnected). |

`PluginInfo`: `{id, name, category: "google"\|"mcp", description,
authKind: "oauth"\|"mcp", account, scopes, capabilities,
available, connectionID?, status?: "disconnected"\|"pending"\|"connected"\|"error",
accountLabel?, error?, connectedAt?}`.

## server → client

| Frame | Payload | Notes |
| --- | --- | --- |
| `hello.ok` | `{v, serverTime, lastSeq}` | `lastSeq` = seq of this frame. |
| `token` | `{turnID, threadID, delta, reset?}` | One streaming chunk. `reset: true` means the text streamed for the current step was narration before a tool call; the client clears the bubble, then applies `delta` (usually empty). |
| `turn.start` | `{turnID, threadID, agentID, conversationID?}` | Turn accepted; called before any `token`. |
| `turn.end` | `{turnID, threadID, stopReason, usage?, conversationID?}` | `stopReason`: `end \| cancelled \| error \| timeout \| budget`; `usage`: `{provider, model, inputTokens?, outputTokens?, latencyMs?}` (latencyMs is server-measured model call time). |
| `tool.start` | `{callID, name, preview?}` | Tool activity strip. |
| `tool.update` | `{callID, preview?}` | |
| `tool.end` | `{callID, ok, preview?}` | |
| `approval.request` | `{requestID, action, preview, buttons, source?, tier?, expiresAt?, truncated?}` | `buttons`: subset of `once \| always \| reject`. `always` is offered only when the call can be remembered (one bot, one tool, one target); it is never offered for a shell command (`bash`), for `run_privileged`, or for a write outside scratch. A card replayed to a reconnecting client carries the same `buttons` it was first sent with. Optional, all additive: `source` is a list of `{kind, label?}` (newest first; `kind`: `web \| email \| agent \| attachment \| connector \| scheduled \| unknown`) naming the untrusted input the run read before this call, with `label` already one clean line; `tier` is 1 (an undoable change), 2 (sends data out or cannot be undone) or 3 (runs a command); `expiresAt` is an ISO time, 10 minutes after the card for a chat turn and 30 for a background job, and past it the answer is no (an expired card is a denial, and the bot is told so); `truncated` is true when the owner must open the whole text (`approval.full`) before Allow once: the preview hides part of the call, or it is long (over 2,000 characters or 40 lines) though every character of it is there, so a card is not allowed on a glance. The client asks `approval.full` and shows the answer first (the server shows every field that decides what runs whole, up to 20,000 characters of card; a call longer than that is refused before any card is raised, so no card is ever cut by that limit). A card replayed on reconnect keeps the same values. |
| `approval.closed` | `{requestID, kind, reason}` | The card for an `approval.request` or `form.request` is no longer actionable; clients remove it. `requestID` is the `apr_...` id of the approval, or the id of the form. `kind`: `approval \| form`. `reason`: `decided` (an answer was recorded, here or on another device) `\| expired` (it timed out) `\| cancelled` (its turn ended or was stopped). Additive in v2 (no version bump); clients that predate it ignore it as an unknown frame. |
| `secret.request` | `{requestID, purpose, command, kind, expiresAt, threadID?, conversationID?}` | A command needs the owner's password. The frame carries no secret; the owner types it into a secure field. Replayable on reconnect; expires after two minutes. |
| `secret.cancel` | `{requestID, reason}` | The prompt was resolved, expired, cancelled, or its turn stopped. Replayable. |
| `form.request` | `{requestID, question, options?, multiple?, kind?, email?}` | A question the agent put to the owner. `kind` is `choice` (a list of options) or `email` (a draft to approve: `email` carries `from`, `to`, `subject`, `body`). `multiple` means more than one option may be chosen. The owner answers on the `form.answer` frame — or types instead of choosing, which dismisses the question and steers the work with their message. |
| `notify` | `{title, body, sound?, threadID?, agentId?}` | Push-worthy event; Mac opens the referenced thread when clicked. |
| `agents.update` | `{agents: [{id, name, color?, model?, role?, tools?, onboarded?, visibility?}]}` | Roster snapshot. `onboarded` is set once the agent has been named, which settles the "what should I call you?" prompt. `role` is what the agent is for, in the owner's words ("inbox manager"). `visibility` is what other agents may see of that agent's work: `private` (a receipt only), `summary` (one line) or `shared` (full text). |
| `thread.list.ok` | `{threads: [{id, agentID, title?, updatedAt}]}` | Answer to `thread.list`; addressed to the requester. |
| `thread.history.ok` | `{threadID, title?, messages: [{id, role, text, createdAt, turnID?, stopReason?}]}` | Answer to `thread.history`; addressed to the requester. `stopReason` is how the turn that produced an assistant message ended (`end`, `cancelled`, `error`, `timeout`, `budget`, ...); it is absent for other roles and while the turn is still running. Additive in v2. |
| `conversation.ok` | `{conversationID, agentID, sessionID}` | Answer to `conversation.open`; `sessionID`: the active block, `""` before the first block. Addressed, not replayed. |
| `session.start` | `{conversationID, sessionID, reason}` | A block boundary inside the conversation; `reason`: `manual \| context \| background`. Replayable. |
| `conversation.history.ok` | `{conversationID, messages: [{id, role, text, createdAt, turnID?, sessionID?, stopReason?}], runningTurn?: {turnID, threadID, agentID}}` | Answer to `conversation.history`; addressed to the requester. Clients render a session divider wherever consecutive `sessionID`s differ. Rows the server fed a turn (a scheduled job's instructions, a delegated task's wake text) are stored with role `system` and are left out; system notices the app posted to the channel (an interrupted reply, a handoff) are kept. `stopReason` is as on `thread.history.ok`, with one addition: the owner's own message names its turn in `turnID`, and carries `stopReason` when that turn ended without writing a reply (`cancelled`, `error`, `timeout`, `budget`), so a client can show "No reply, stopped" after a reload. Additive in v2. `runningTurn` (additive in v2) names the turn running in this conversation when there is one, so a client that reloads mid-turn can show Writing and Stop at once; `msg.cancel` with its `turnID` stops it. |
| `thread.export.ok` | `{conversationID, url, token, records, createdAt}` | Answer to `thread.export`; addressed to the requester, not replayed. `url` is absolute and served by this daemon at `GET /share/<token>`; the token is the only access control on the file, so it is never logged or replayed. |
| `job.list.ok` | `{jobs: [...]}` | Answer to `job.list`, `job.set`, or `job.delete`; addressed to the requester. Each job also carries, additively: `dailyAt` (`"HH:MM"` in the server's time zone, for a wall-clock recurrence), `days` (with `dailyAt`: the weekdays it fires on as `sun`..`sat`; absent means every day), and `internal` (`true` for the daemon's own housekeeping: `tagger`, `memory.embed`, `memory.consolidate`, `summary.rollup`, `rollover.summarize`, `db.backup`, `harness.review`; the server always sends it, and a job without it is the owner's). A job with `everyMs` recurs on an interval instead. |
| `approval.rules.list.ok` | `{rules: [{id, agentID, agentName, toolName, target, createdAt, resourcePattern?, account?}]}` | Answer to `approval.rules.list`; addressed to the requester, not replayed. A rule is scoped to one bot, one tool and one target (the exact command, the resolved path, or the recipient list). `agentName` is `null` when the bot no longer exists. |
| `approval.rule.revoke.ok` | `{id}` | Answer to `approval.rule.revoke`; addressed to the requester, not replayed. |
| `approval.full.ok` | `{requestID, text, cut?}` | Answer to `approval.full`; addressed to the requester, not replayed. `text` is the whole call (for a long card that was not cut, the whole preview it was raised with), every invisible character escaped as on the card; `cut` is true when even this text hit the size limit (1 MB). Additive in v2. |
| `policy.pause.ok` | `{paused, changedAt?, stopped, bots: [{agentID, name, enabled, runningTurns, scheduledJobs}]}` | The pause state: all bots paused or not, and every bot's on/off state with what turning it off would stop (`runningTurns`, `scheduledJobs`: the counts for the "Turn off Ava?" dialog). Broadcast and replayable when it changes, and sent to a client after `hello`; `stopped` is how many running turns the change that caused the frame stopped (0 for a read or a hello). Additive in v2. |
| `spend.status.ok` | `{day, resetsAt, timeZone, caps: {dayUsd, perBotDayUsd, perJobUsd}, daySpentUsd, bots: [{agentID, spentUsd, capUsd}], unpricedCalls}` | Today's spend (the server's local day) against the caps; a cap of `null` is no cap. Spend counts priced calls only; `unpricedCalls` says how many calls had no price. Answers `spend.status`, and is broadcast after `spend.caps.set`. An `error` with code `spend_unavailable` answers when the build has no spend ledger. Additive in v2. |
| `spend.stopped` | `{runKey, agentId?, scope, reason, spentUsd, capUsd, message}` | A run was stopped because spending reached a cap (or could not be counted). `message` is the three-line notice the owner also sees in the chat; the rest lets a client draw "Raise ... limit" and "Continue once". `scope` is `day` (all bots today), `bot` (one bot today) or `job` (this task); `reason` is `over_cap`, `cost_unknown` (spend that could not be priced is in the scope) or `budget_unreadable`. `runKey` goes back in `spend.continue`. Additive in v2. |
| `spend.continue.ok` | `{runKey, grantedUsd}` | Answer to `spend.continue`: how many dollars the run may spend on top of its caps. Addressed to the requester. Additive in v2. |
| `task.list.ok` | `{tasks: [...], lists: [...]}` | Task snapshots include due date, deadline, priority, workflow status (`not_started`, `in_progress`, `ai_review`), current progress note, list/collection, labels, optional parent, notes, reminder time, repeat cadence and attachment IDs. Lists include open task counts. A delegation task also carries `ownerAgentId`, `origin`, `intent`, `delegateState`, `jobId`, `result` and `resultRedacted`. `intent` is what the delegation is for (`request`, `result`, `question`, `status`, `fyi`) and reads as `request` when absent. The owner sees every result; `resultRedacted` is true when a result exists that this viewer may not see. |
| `task.create.ok` | `{task: {...}}` | Newly persisted task. |
| `task.list.create.ok` | `{lists: [...]}` | Updated task list navigation. |
| `task.activity.ok` | `{taskID, activity: [...]}` | Recent task activity, newest first. |
| `task.update.ok` | `{task: {...}}` | Updated task snapshot after a persisted state change. |
| `task.updated` | `{task: {...}}` | A delegated task changed state (queued, running, needs_input, done, failed). Replayable. |
| `task.answer.ok` | `{task: {...}}` | The answer was accepted; the task is running again. |
| `bind.direct.ok` | `{agentID, conversationID, sessionID, channelID}` | The client is bound to that agent's conversation; `sessionID` is the active block, `""` before the first one. Addressed, not replayed. |
| `provider.add.ok` | `{providers: [...]}` | Provider metadata after adding a key; contains no credentials. |
| `provider.auth.started` | `{providerID: "chatgpt", loginID, authorizeURL, expiresAt}` | Requester-only, never replayed. Opens OpenAI's authorization page. Contains no access, refresh, or ID token. |
| `provider.auth.state` | `{providerID: "chatgpt", connection}` | Public state: `status`, saved `accounts [{id,label,connected}]`, `activeAccountID`, selected `model`, eligible `models [{id,label}]`, optional safe `message` and first-sign-in `showWelcome`. Never includes credentials. |
| `presence` | `{state}` | `online \| offline`. |
| `status.update` | `{channelId, agentId?, text, transient}` | Activity text; transient updates clear on the next message. |
| `msg.new` | `{id, channelId, fromType, fromId, senderName, senderColor?, text, internal, uiHint?, intent?, toAgentId?, taskId?, questionId?, createdAt}` | Durable channel message; `uiHint` can be `onboarding_name_prompt`, `handoff_notice`, `progress`, `needs_input`, or `normal`. `intent` says what an agent-to-agent message is for (`request`, `result`, `question`, `status`, `fyi`); it is absent on ordinary messages. The live frame for a handoff notice always carries one, defaulting to `request`; a notice reloaded from history has none, because channel rows do not store intent. `toAgentId` names the agent a handoff notice is about, so the client can render the name as a link to that agent's chat. `taskId` + `questionId` mark a question from a delegated task: the client renders an answer field that sends `task.answer`. |
| `agent.updated` | `{agentId, displayName, onboarded, role?, visibility?}` | Agent rename/onboarding state changed. `role` and `visibility` are present when the change touched them (an `agent.profile` edit). |
| `push.vapid` | `{publicKey}` | Answer to `push.vapid.get`: the base64url VAPID public key for `pushManager.subscribe`. |
| `agent.proactivity` | `{agentId, quietStart, quietEnd, maxPerDay}` | A bot's proactivity settings (answer to the client frame of the same name). |
| `channel.created` | `{channel: ChannelInfo}` | Phase 4. A group channel exists. `ChannelInfo` is `{id, name, type: "group", agentIds, createdAt}`; `agentIds[0]` is the primary bot. |
| `channel.list.ok` | `{channels: ChannelInfo[]}` | Phase 4. Answer to `channel.list`. |
| `channel.history.ok` | `{channelId, messages: MessageInfo[]}` | Phase 4. Answer to `channel.history`. |
| `error` | `{code, message, retryAfter?}` | See codes below. |

A task turn speaks in messages, not one growing reply: each completed assistant
message is published as its own ordinary `msg.new` after that message's `token`
chunks. Clients seal the streaming bubble under the durable `msg.new` id and
open a fresh bubble for the next chunks. `uiHint: "progress"` rows (`say`) are
separate messages and never seal the answer.

In the task lane the narration a model writes *between* its tool calls stays in
the model's own context: it is never published as a message. Only `say`
progress rows and the final answer become messages. Every step streams live,
because the server cannot know a step is narration until the step ends. When a
step that streamed text turns out to call tools, the server sends one
`token {delta: "", reset: true}` and the client clears that text from the
bubble. A client that ignores `reset` still shows the right answer: the sealing
`msg.new` replaces the bubble's text.

## Error codes (v2)

`bad_frame`, `unauthorized`, `version_mismatch`, `unknown_thread`, `unknown_conversation`,
`unknown_agent`, `unknown_request`, `unknown_job`, `unknown_task`,
`bad_task_action`, `capture_failed`, `job_running`, `already_running`, `no_provider`, `provider_failed`,
`unknown_provider`, `invalid_key`, `provider_exists`, `provider_storage`, `provider_auth`,
`unknown_plugin`, `unknown_connection`, `plugin_not_configured`, `plugin_unavailable`,
`plugin_connect_failed`, `unknown_background`, `unknown_channel`, `invalid_attachment`,
`invalid_domains`, `resync_gap`, `not_found`, `not_running`, `agent_off`, `paused`, `bad_cap`, `spend_unavailable`, `internal`.

The four codes that answer one client frame (checked in `apps/server/src/ws/dispatch.ts`):

- `not_running`: `msg.cancel` names a turn that is not running. It finished, never existed, or the server restarted.
- `unknown_request`: `approve.reply` or `form.answer` names a request that is not pending any more (decided, expired, or its turn has ended). `secret.reply` or `secret.cancel` names a secret prompt that is not pending.
- `already_running`: `job.set` with `action: "run"` on a job that is running now. Nothing is queued.
- `not_found`: `approval.rule.revoke` names an unknown or already revoked rule, or `approval.full` names a card that is gone.
- `agent_off`: `msg.send` addresses a bot the owner turned off. The message is not stored; the text says to turn the bot on.
- `paused`: `session.new` or `bind.direct` (which summarise with the model) while all bots are paused, or while the pause state cannot be read (which counts as paused).
- `bad_cap`: `spend.caps.set` has a cap the server cannot use (a bot's daily cap above the daily cap). Nothing changed.
- `spend_unavailable`: `spend.status` or `spend.caps.set` on a build with no spend ledger.

## Versioning

`PROTOCOL_VERSION` bumps on any breaking change (removed/renamed frame or
field, changed semantics). Additive optional fields do not bump the version;
clients must ignore unknown fields. The server rejects `hello` with an
unsupported `v` instead of guessing.

## Replay log (v1 bounds)

The server keeps the last `AGNI_FRAME_LOG_CAPACITY` outbound frames (default
1000) for `resync`. Deltas are frames too, so a client offline through a long
turn will likely reload rather than replay — by design: messages are durable
in SQLite, replay is a latency optimization, not a storage layer.

`hello.ok` and the `thread.list.ok` / `thread.history.ok` answers are for one
connection, not the shared stream: they consume a `seq` like every frame but
are skipped on replay. A client never "missed" a reply addressed to someone
else. Everything else — turns, tokens, tool strips, approvals, notifications —
is replayable.

### Pause, per-bot off and approval expiry (additive v2 extension, Sprint 2)

One switch pauses everything and any bot can be turned off. Both are stored in the
database, so `agni pause` / `agni resume` from a terminal works on a running server
(the server notices within a second). While paused:

- running turns are stopped (their `turn.end` has `stopReason: "cancelled"`), and each gets
  a `status.update` `Stopped: you paused all bots. Work done so far is kept.` in its channel
  (`Stopped: you turned <bot> off.` for one bot);
- a `msg.send` is accepted and kept, a `status.update` says `Waiting: bots are paused.`, and
  the messages are answered in order after `policy.pause` with `paused: false`;
- a scheduled job of a paused or switched-off bot that comes due is skipped and recorded as
  `skipped (paused)` or `skipped (bot off)`; it does not run late on resume (a recurring job
  waits for its next slot). Housekeeping, task reminders and the morning brief start no bot
  and go on;
- an approval card that belongs to a stopped turn is closed (`approval.closed`, `cancelled`); a late
  answer to it is an `unknown_request` error, as for any card whose turn ended.

A pause made with `agni pause` on the command line stops running turns within a second and starts
held messages within a second of `agni resume`, but sends no per-turn `Stopped:` notice (the turn's
`turn.end` still says `cancelled`).

A pause check that cannot read its state fails closed: it counts as paused. `agni`, the old id of the main assistant, and `ea` are one bot, so turning one off turns off the other. Housekeeping that calls the model (tagging, summaries, embedding) also waits while everything is paused.

Pause-all and per-bot off are independent: resuming all does not turn on a bot that was off.
A client learns the state from `policy.pause.ok` after `hello` and whenever it changes;
`agents.update` carries `enabled: false` on a bot that is off.

Approval cards expire: 10 minutes for a chat turn, 30 for a background job (`expiresAt` on
`approval.request`). Expiry is a denial, not a pass: the call does not run and the bot is told
no. The audit log (`agni audit verify`) records approvals, config changes, pause and resume.

### Attachments (additive v2 extension)

`msg.send.files` now carries up to five opaque uploaded attachment IDs, rather
than client filesystem paths. No existing shipped client sent paths before this
change: the Mac app sends `nil` and the CLI omits the field. Files must have
been uploaded by the sending device. Text remains required; the web app
uses "Please review the attached files." for an attachment-only message.
`msg.new` and history `MessageInfo` objects optionally include `attachments`:
`{ id, name, mimeType, size, kind: "image" | "text" | "pdf" }[]`.
Existing text-only clients remain compatible; no version bump is required.

File bytes use HTTP with `Authorization: Bearer <device-token>` (never a token
in a URL). `POST /attachments` accepts one multipart `file` and returns
`{attachment}`; `POST /attachments/validate` accepts `{ids}` and checks ownership
and vision availability before sending. `GET /attachments/:id` downloads a file;
`DELETE /attachments/:id` removes an unlinked draft owned by that device.
`GET /attachments` reports limits and whether a vision model is configured.
Paired devices share sent attachments; unlinked uploads remain private to their
uploading device. Unlinked files expire after 24 hours and are pruned on upload.

Limits: five files per message, 10 MB each, 500 MB total stored attachments;
images at most 8192 pixels on either side and 20 megapixels; UTF-8 text and PDF
extraction at most 60,000 characters per file; PDFs at most 100 pages with a
15-second extraction timeout. Model requests include at most five recent files
and 24,000 characters of extracted text, with explicit truncation notices.
Scanned PDFs, Office documents, audio, and video are not supported.
Image-capable configured model IDs are explicitly listed in `AGNI_VISION_MODELS`.
Provider failover for images only uses that allowlist. File contents are treated
as untrusted user data. Binary image content is expanded at the provider boundary,
not stored as base64 in session logs.

### Appearance profiles (additive v2 extension)

Appearance profiles are versioned semantic settings rather than CSS. Version 1
contains a name, light/dark/system mode, a built-in surface preset, an accent,
background settings, text scale, density, corner style, motion preference, and
agent-colour strength. The daemon stores named profiles and broadcasts the
active selection so web and Mac clients stay aligned. Clients may cache the
last active profile to avoid painting the default theme while reconnecting.

Background bytes use authenticated HTTP and are never conversation
attachments. `POST /backgrounds` accepts one PNG, JPEG, or WebP image up to
10 MB and returns `{id}`. `GET /backgrounds/:id` requires a paired-device
Bearer token. `DELETE /backgrounds/:id` refuses to remove an image referenced
by a saved profile. Paths are generated server-side, bytes are content-sniffed,
and the assets are never sent to a model. Theme JSON exports omit image bytes.

### Routines (additive v2 extension)

A `routine`-kind job in `job.list.ok` may carry an optional `routine` object
on its `JobInfo`: `{name, cron, timezone, misfire: "skip"|"run_once",
preflight: "http"|"sql"|"none", maxTokens, maxExecutionMs, allowedDomains,
successStreak, failureStreak, recentRuns}`, where `recentRuns` holds at most
the last five runs (`{at, outcome, tokens, summary?}`, `outcome`:
`ran | skipped_no_delta | failed | timed_out | budget_exceeded`). This is an
optional-field change: no new frames and no version bump, and the Swift
client ignores unknown fields. Ordinary `turn` jobs never carry `routine`.

One new client frame, `routine.domains.set` `{jobID, domains}`, replaces a
routine's `allowedDomains` (at most 20 bare hosts, no scheme, slash or port).
Malformed input returns `invalid_domains`. Only the owner's connection can send
it; a bot's tools cannot, so a bot cannot widen its own egress. The reply is
`job.list.ok`, as for `job.set`.

### Editable memory (additive v2 extension)

The memory view can change what a bot remembers, not only read it. Every
frame below acts only on a row the caller would see in `memory.list` (the
same scope and visibility filter retrieval uses); any other id answers
`unknown_memory`. All are additive: no version bump.

| client → server | Fields | Effect |
| --- | --- | --- |
| `memory.list` | `{scope?, limit?}` | Lists memories (`global_user` by default, or `agent`). Answer: `memory.list.ok {memories}`. |
| `memory.update` | `{id, text}` | Replaces the text. The old text is kept as a superseded version; the new one is owner-stated (`source: user`). Answer: `memory.update.ok {memory}`. |
| `memory.pin` | `{id, pinned}` | Pinned memories (salience 1.0) lead the owner profile in every prompt; unpinning sets salience 0.5. Answer: `memory.pin.ok {memory}`. |
| `memory.forget` | `{id}` | Hard-deletes the memory and its whole version chain. Answer: `memory.forget.ok {id, deleted}`. |
| `memory.conflicts.list` | `{limit?}` | Unresolved conflicts: a fact that replaced an older, different one. Answer: `memory.conflicts.list.ok {conflicts: [{id, memoryId, previousId, content, previousContent, createdAt}]}`. |
| `memory.conflict.resolve` | `{id, keepId}` | `keepId` is the conflict's `memoryId` (keep the new value) or `previousId` (restore the old value, as an owner edit). Answer: `memory.conflict.resolve.ok {id, memory}` with the memory now live. |

Errors: `unknown_memory` (not visible, or no longer live), `unknown_conflict`
(no open conflict with that id), `bad_frame` (`keepId` is neither side).

## Group channels (Phase 4)

A group channel holds the owner and two or more bots. Send into it with
`msg.send {channelId}`. Floor rule: a message that starts with a member
bot's `@name` goes to that bot; anything else goes to the primary bot
(`agentIds[0]`), which may hand off. A mention of a bot outside the group
does not move the message out of the room. Every message and every reply
is a `msg.new` on the group's `channelId`.

Each bot answers from its own conversation, so its memory stays its own.
It sees the room as a short block of recent group messages in its model
input; every other bot's line passes through the visibility filter, so a
`private` bot shows as "(replied; private)" and a `summary` bot as one
line. The group has no shared summary and is not compacted, and the tagger
batches each bot's exchanges separately. These frames are additive and
optional: `PROTOCOL_VERSION` stays 2.

### Appearance V2 clients

Web and Mac expose one current appearance with editable built-in presets.
Adjustments render locally immediately and autosave after a 400 ms pause.
Pending settings are cached on the device and retried on reconnect; an older
server snapshot cannot replace an unsynced adjustment. Clients display Saved
only after receiving the matching `appearance.updated` or `appearance.list.ok`
snapshot, and offer retry after a send failure or an eight-second timeout.
Slider drags form one undo adjustment. Reset restores the built-in defaults.

The profile wire format and legacy list/activate/delete frames remain available
for compatibility. V2 updates the current profile in place and removes profile
management from both settings interfaces; existing stored profiles are retained.
No protocol version change or database migration is required.

### Desktop appearance V3

Optional appearance fields `bubbleColor` (six-digit hex), `conversationWidth`
(`comfortable` or `wide`), and `transparency` (`subtle` or `off`) extend version-1
appearance profiles without changing protocol version 2. Missing fields use blue
outgoing bubbles, wide conversations, and subtle header transparency. Bot identity
and app accent remain separate from the outgoing bubble colour. V2 live saving,
backgrounds, undo and reset continue to work. Sidebar width and pinned bots are
local device preferences. Visual grouping never changes stored message boundaries.
