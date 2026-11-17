# Agni Bot

Agni Bot is a messaging app for bots. You talk to named, specialised bots to get
work done. Each bot has its own name, role, and memory. It is like messaging a
friend, with the people removed and bots in their place. Performance comes
before UI polish. Our own server, our own apps, free model tiers called by API,
and a Gmail mailbox for the agent. Full plan:
[`docs/blueprint-v3.html`](docs/blueprint-v3.html). Doc index:
[`docs/README.md`](docs/README.md).

**Source-available, free for non-commercial use.** Anyone may use, fork, and
modify it; selling it or using it commercially is not allowed. See
[`LICENSE.md`](LICENSE.md) (PolyForm Noncommercial 1.0.0).

The fork's first model sources are Qwen and DeepSeek, chosen to keep running
costs low. Built-in provider entries for them are planned. The providers built in today are
listed in [`docs/architecture.md`](docs/architecture.md).

## Layout

| Path | What it is |
| --- | --- |
| `apps/server` | Bun + TypeScript core: WebSocket protocol, agent loop, policy gate, model router, SQLite stores, encrypted secrets vault, daemon lifecycle, job queue. Its command line is the `agni` command. Runs on this Mac now, bb-1 later. |
| `apps/web` | React + Vite web client, a faithful port of the native Mac UI. Shares `@agni/client` with future shells. |
| `apps/mac` | Native SwiftUI macOS client (`AgniApp` + `AgniKit`). Token in Keychain, resumable streaming. |
| `apps/app` | Planned Tauri 2 client (macOS + Android). README only; no runnable code yet. |
| `packages/client` | Client core: frame decoding, connection loop, conversation reducer, settings, formatting. Used by the web app; the reference for the Swift port. |
| `packages/protocol` | Wire protocol v2: typed frames shared by server and every client. This is the contract. |
| `apps/cli` | Protocol client: `chat` (interactive), `ask`, `threads`, `history`, `bench`, `ping`. The P0 proof gate (`bench`) lives here. |
| `infra` | Deploy material: `install.sh`, `launchd/`, `systemd/`, `env.example`, `firecrawl.compose.yml`, `wrangler.toml`. See `infra/README.md`. |
| `tools` | Dev tools only (mock provider, read-only audit). |
| `docs` | Architecture, protocol, plugins, and routines. `docs/README.md` says which docs are current and which are upstream history. |

## Quickstart

Install and run as a login service (macOS launchd, Linux systemd --user):

```sh
npm i -g agni-bot           # or: bun add -g agni-bot  (needs Bun 1.3+)
agni setup                  # ~/.agni, secrets vault, login service, opens the browser already paired
```

Or with the install script (clones the repo into `~/.agni/app`):

```sh
curl -fsSL https://raw.githubusercontent.com/Nachikethreddyy/agni-bot/main/infra/install.sh | bash
# or, from a checkout: bash infra/install.sh
agni open                   # pair another browser
agni service status
```

The installer installs deps, builds the web app, writes `~/.agni/config.env`,
chooses where secrets are kept (see [Where secrets are kept](#where-secrets-are-kept)),
installs the `agni` command, and registers the service. Manage it with
`agni service install|uninstall|status`. `agni doctor` shows how secrets are stored.

Dev flow from a checkout:

```sh
bun install
cp infra/env.example .env   # add at least GROQ_API_KEY and/or NVIDIA_API_KEY
bun run migrate
bun run daemon start        # run the server detached in the background
bun run pair --name Mac     # prints a device token once — save it
export AGNI_TOKEN=agni_…
bun run chat                # talk to it; /help lists commands
bun run daemon status       # pid, uptime, provider health, usage today
```

Foreground alternative while hacking: `bun run dev` (watch mode). Both modes are
the same process; the daemon just detaches it, writes `~/.agni/run/agni.pid`,
appends to `~/.agni/logs/agni.log`, and waits for `/health` before reporting
success. (Paths come from `AGNI_PID_PATH` and `AGNI_LOG_PATH`; see `infra/env.example`.)
All state lives in `AGNI_HOME` (default `~/.agni`).

On Windows, shell tools require Git for Windows (Git Bash). Agni uses that
host-native shell rather than the Windows WSL launcher. Temporary credentials
and privileged scripts use an owner-only Windows ACL; Unix hosts use file modes.

### Web app

`apps/web` is the React port of the SwiftUI client. The workspace runs on Bun
workspaces for the server, CLI, web, and tests.

```sh
bun install
bun run daemon start
bun run open                # opens the browser already paired (one-time code, 10 min)
bun run web                 # Vite dev server on http://127.0.0.1:5173 (proxies to 8787)
```

Outside development the daemon serves the web app itself at
`http://127.0.0.1:8787`; no Vite server is needed. Pairing uses a one-time code
(`ABCD-EFGH`, 10 minutes, single use) that `agni open` fills in for you. The
browser then holds an HttpOnly, SameSite=Strict cookie; the token is no longer
kept in `localStorage`. `bun run pair` still prints a device token for the Mac
app and CLI. For remote access, run `tailscale serve --bg 8787` and set
`AGNI_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` in `~/.agni/config.env`.

The local server answers only the `Host` and `Origin` names it expects. Every
route needs a paired device except the app shell, pairing, `/health` (liveness
only), the WebSocket handshake, the OAuth callback, and share links. Pairing
allows 5 attempts a minute per address and 20 a minute in total. The session
cookie lasts 30 days and slides forward on each visit.

Each main screen has its own address, so a reload keeps you on it and the back
button works:

- `/agent/<id>`: a bot's conversation
- `/group/<id>`: a group channel
- `/task/<id>`: one task
- `/tasks` and `/tasks/<view>` (for example `/tasks/inbox`): the Tasks screen
- `/settings` and `/settings/<section>`: Settings (`general`, `appearance`,
  `plugins`, `approvals`, `spending`, `models`, `device`)

An unknown id or view shows a not-found state and keeps the address you typed.
The shell and the conversation are laid out for a 375 px phone screen.

Useful commands:

```sh
bun run check               # typecheck, web and client tests, server tests, and evals
bun run check:security      # security gates; the scanners are installed outside the repo (see scripts/check-security.ts)
bun run web:build           # production bundle in apps/web/dist
bun run --filter @agni/client smoke   # headless client core against a live daemon
bun run --filter @agni/web smoke:ui   # Playwright smoke (needs AGNI_URL/AGNI_TOKEN
                                      # and a running Vite dev server)
```

### Connect a ChatGPT plan

In the web app, open **Settings → Models & providers → Add provider**, choose
**ChatGPT**, and click **Continue with ChatGPT**. Complete OpenAI's sign-in and
allow Agni to use your ChatGPT plan; Agni selects an eligible model automatically.
No API key is needed. Your browser and Agni server must run on the same computer
for this first version's loopback callback. Account/workspace eligibility and
ChatGPT usage limits still apply.

While connected, ChatGPT is the selected model source. An error or usage limit
stops the request rather than silently switching to API-key billing. Settings
lets you choose an account-specific model, reconnect, switch saved accounts, or
disconnect. Disconnecting returns routing to your other configured providers.
Your ChatGPT conversations and memories are not imported.

The daemon owns OAuth, token renewal, and Responses streaming. Registration and
tokens live in the encrypted vault on a fresh install. In file mode they live in
`~/.agni/data/chatgpt/accounts.json` beside the configured database, with
owner-only Unix permissions or a restricted Windows ACL. Browser storage, frame
replay, and model prompts never receive those credentials. Remote sign-out is
attempted before the disconnect completes; a warning explains when revocation
could not be confirmed.

Optional ChatGPT sign-in is off by default. Set `AGNI_CHATGPT=1` to enable it.
It uses OpenAI's [Sign in with ChatGPT token-sharing documentation](https://developers.openai.com/siwc/token-sharing-open-source).
Eligibility under OpenAI's terms is unconfirmed; that is an owner decision still pending.
`provider.auth.*` frames are additive to protocol v2.

### Background work (the daemon doing things on its own)

```sh
bun run job add "Draft my morning brief from yesterday's notes" --at 07:55 --every 1d
bun run job add "In one line: what should I not forget today?" --in 2h
bun run job list --all      # state, next run, last result
bun run job run <id>        # make a job due now
bun run job rm <id>         # cancel
```

Turn jobs run on the daemon's job pool (`AGNI_JOB_CONCURRENCY`, default 2). The model call streams into its thread
(so any client sees it live) and completion raises a `notify` frame. Failures
retry with backoff, then land as `failed` with a notification.

### Pause, spend limits, and the audit log

```sh
agni pause                 # pause every bot: running work stops and nothing new starts
agni resume                # start again (a bot you turned off stays off)
agni policy caps           # show the run limits
agni policy caps set --wall-minutes 45 --delegations 3   # change some of them
agni audit verify          # check the audit log's hash chain; exits 1 if a row was changed
```

Spend caps are checked before every model call. The defaults are $2 a day
across all bots, $1 a day for any one bot, and $0.50 per job. A run that reaches
a cap stops and tells you why, and you can let that run go on once. Change the
caps in the app, under Settings → Spending. Run limits default to 30 minutes of
run time (not counting time spent waiting for you), 4 delegations at once, 10
self-scheduled jobs per bot, and 10 wakes per request. Prices, and the date each
came from, are in `apps/server/src/models/prices.ts`.

The audit log records policy decisions, approvals, taint changes, pause and cap
changes. Each row holds the hash of the row before it, so a changed row breaks
the chain. The architecture is described in
[`docs/architecture.md`](docs/architecture.md), "Policy gate".

### Passwords and other secrets

When a command needs the owner's password (`sudo`, `ssh`, `ssh-add`, git over
HTTPS), the agent calls `run_privileged`. It shows the exact command and a
one-line purpose; the owner types the password into the web app's secure card
or the CLI's hidden prompt. The value goes straight to that one command and is
never returned to the model, written to the transcript, or logged.

- **Web app:** the card appears above the composer. `Authorize` sends it once.
- **SSH / terminal:** `bun run chat` prints a `[secret …]` line; enter it with
  `/secret <requestID>` (input is hidden). Run the CLI on the Mac (or reach the
  daemon over Tailscale) — the daemon binds loopback by default.
- **Expiry:** a prompt lasts two minutes. Cancelling it, stopping the turn, or
  restarting the daemon drops it.
- **No chat pasting:** the agent is instructed never to ask for a password in
  prose. If it does, refuse and use the card.

The secret never goes on the command line or into the environment. It is written
to a 0600 file in a private temp directory, and a 0700 askpass script prints it to
the command. The directory is removed when the command exits. The shell tool then
removes the exact value, and simple variants of it, from the command's output. That
scrub is not complete: a command that changes its output, such as `| rev` or `xxd`,
can hide the value. Your approval of each shell command is the control that matters.

**On a Mac, the operating system can ask instead.** `run_privileged` takes an
`auth` mode:

- `auto` (default) — machine-level commands (`sudo …`) go to the macOS
  authorization dialog (password or Touch ID); everything else (`ssh`, `git`)
  goes to the one-time prompt, because those must run as the owner, not as
  root.
- `os` — always the macOS authorization.
- `password` — always the one-time prompt.

The command is written into a private directory (`mkdtemp`, 0700) as a 0700
script, never into a bare temp file and never into a command line, and the
script is deleted the moment the run ends. The authorization dialog shows the
**command itself**, because the approval covers the whole script.

The owner's password is never stored anywhere — not in the Keychain, not in a
file. The Keychain holds the device token and nothing else.

### Summaries in levels

A session block's summary says what happened in that block. The day summary
says what happened in the day, and the epoch summary says what happened over
a week. The rollup is deterministic — the union of the day's decisions and
open loops — so it costs nothing, runs in the background, and is
idempotent. Each level keeps the range it came from, so a summary can
always be traced back to the turns that produced it.

### What Agni remembers, seen from the app

The Inspector has a **Memory** section: every fact the agent holds, with its
scope, where it came from, how sure the agent is, and how often it is
recalled. The list is filtered by the same rules the retrieval uses, so
nothing shows there that the agent could not have recalled — a private
agent's fact is not in the list, and another agent's scoped note is not
either.

The web Inspector is read-only today. The protocol has frames to edit, pin, and
forget a memory (see [`docs/protocol.md`](docs/protocol.md), Editable memory).

### The acceptance suite

```sh
bun run eval           # the deterministic evals
bun run eval:nightly   # the same, with the nightly policy
```

Seven evals, each measuring a promise the system makes and failing when the
promise breaks:

| Eval | What it measures |
|---|---|
| EVAL-001 | needle recall — facts planted early, found by a vague question after the blocks rolled over |
| EVAL-002 | the gate's misses, and that the rollover sweep catches them |
| EVAL-003 | continuity — an ephemeral follow-up keeps its referent |
| EVAL-004 | leaks — private and scoped content never reaches the caller |
| EVAL-005 | cost — the retrieval is cheap enough to sit on the turn's path |
| EVAL-006 | drift — the summary and the source still agree |
| EVAL-007 | provider-backed quality — checks that need a live model provider |

They run against an in-memory database and a stub model, so they measure
the *system* rather than the luck of a provider. EVAL-001b (the hybrid recall
check) is skipped when no embedder is configured. EVAL-007 is always skipped:
its live-provider path is not part of the deterministic suite.

### Seeing what the agent is doing

The sidebar shows a quiet dot next to an agent that is working, waiting for
you, or blocked — so "working" and "waiting for you" are not the same
silence. Under each answer there is a one-line activity strip (expandable)
showing what the agent did, so progress does not depend on the model
remembering to narrate.

Interrupting works the way it should: a new message stops the running turn
and takes over, instead of bouncing off a busy thread.

### Agent visibility

Every agent has a visibility that says what *other* agents may see of its
work:

- `private` — nothing leaves the agent. Another agent gets a receipt: the
  task, the state, and the fact that it finished. The work stays in that
  agent's own conversation, which the owner can open directly.
- `summary` — the caller gets one bounded line: enough to report an outcome,
  not the working.
- `shared` — the caller gets the full text. The shipped team is `shared`
  (the executive assistant is the owner's proxy), and a new agent created in
  chat starts at `summary`.

The rules live in one module, `agent/visibility.ts`. Handoffs, delegated
results, background results, group chat, and the critic step call its helpers. A fact is scoped the same way: `scope=agent` memory is unreadable
by other agents, and a private fact is readable by its owner alone.

Change it with `update_agent` (`visibility: private | summary | shared`) or
in the app.

### What Agni remembers, and what it may not

Memory is extracted in batches, after a turn — never on the path of one. A
turn that is small talk produces nothing.

- **The source decides the scope.** Only what the owner said (or something
  verified) may become a fact *about the owner*. A tool result, a web page
  or an email is data: a page that says "the user prefers dark mode" is a
  prompt-injection attempt, not a fact. What a conversation *implies* is
  kept as that agent's own note.
- **Confidence has a floor.** An item the extractor is not sure about stays
  in the transcript and is not promoted.
- **Strict schema.** Every extracted item is validated; an invalid one is
  dropped and logged, never stored.
- **Changes are flagged.** When a new fact contradicts an older one, the new
  one wins and the old one is closed — and the conflict is recorded
  (`memory_conflicts`) rather than hidden.

### Blocks that roll over without making you wait

A session block is the unit of context. When one fills up, it is closed and
a new one opens **immediately** — the turn never waits for a summary. The
new block opens with the previous summary plus the last six turns of the
old one, and the summary of the closed block is written in the background.
A second rotation that lands before the first summary does not lose the
newer one.

The trigger is 65% of the block budget, with hysteresis above it, so a
block hovering near the threshold does not thrash. An idle gap plus a topic
shift also starts a new block.

### Search and memory

Facts and the conversation transcript are indexed with SQLite FTS5, so
recall is a real search rather than a substring match. A search is ranked
with

```
score = relevance * recency_decay(last_used_at) * salience * (1 + log(1 + use_count))
```

and a recall moves `last_used_at` and `use_count`, so the formula reflects
what actually gets used. Below the confidence floor (`AGNI_MIN_RECALL_SCORE`,
default `0.2`) nothing is injected — a plausible match that is not good
enough is still nothing.

The agent can search the transcript itself with `transcript_search`; the
search respects the same visibility rules as everything else, so a private
agent's conversation is not searchable from outside.

Retrieval is hybrid when an embedder is configured (`AGNI_OLLAMA_BASE_URL` for
Ollama, or `AGNI_EMBEDDING_BASE_URL` for an OpenAI-compatible endpoint).
`AGNI_EMBEDDING_MODEL` sets the model name. The text search comes first — it is local and
fast — and the embedder is the *lift* for the cases the text search cannot
serve. If the embedder is down, recall falls back to FTS alone. There is no
vector service: the vectors live in the database and the similarity is
computed in JavaScript.

A nightly sweep keeps the store honest: it closes what is already
superseded, merges duplicates, archives what nothing has used in months,
and promotes what is used often into the pinned profile. It never deletes
anything — forgetting is still the owner's call.

The slot budgets of the context assembler are configuration:
`AGNI_SLOT_PINNED_CORE`, `AGNI_SLOT_ANCHOR`, `AGNI_SLOT_LEDGER`,
`AGNI_SLOT_SUMMARIES`, `AGNI_SLOT_RECALL`, `AGNI_SLOT_PREVIOUS_TAIL` (tokens).

### Smoke test without any keys

```sh
bun run mock &              # healthy provider on :9911
MOCK_PORT=9912 MOCK_FAIL=1 bun run mock &          # 429s — failover fixture
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:9912/v1 \
LMSTUDIO_BASE_URL=http://127.0.0.1:9911/v1 LMSTUDIO_MODEL=mock \
  bun run serve &                                   # answers via LM Studio after Groq 429s
```

With the mock running, the daemon and chat also work keyless:

```sh
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:9911/v1 bun run daemon start
AGNI_TOKEN=… bun run ask "what is 2+2"    # → mock(mock-model): what is 2+2
```

## Environment

Configuration lives in `~/.agni/config.env` (mode 600), written by the installer.
A repo-root `.env` still works in dev and wins over it. See
[`infra/env.example`](infra/env.example) for the full list — providers are enabled
by the presence of their key, everything else has a working default. API keys
added in the web UI go into the encrypted vault on a fresh install, and into
`~/.agni/config.env` in file mode (below).

### Where secrets are kept

A fresh install keeps provider keys, plugin tokens and other credentials in an
encrypted vault, `~/.agni/vault.bin` (AES-256-GCM). Its key is held by the
operating system's credential store: Windows Credential Manager, the macOS
Keychain, or a Linux Secret Service. `config.env` then holds only settings, and
`AGNI_SECRETS_MODE=vault` is recorded in it by `agni setup`.

`AGNI_KEYSTORE` (`auto`, `bun-secrets` or `passphrase`) chooses the keystore, and
`auto` is the default. A vault remembers which keystore made it. A different choice is
refused rather than guessed.

- **No usable keystore** (headless Linux with no Secret Service, no Credential
  Manager): `agni setup` says why and how to enable the vault later, then uses
  *file mode*: credentials stay in `config.env`, readable only by you (mode 600,
  or an owner-only ACL on Windows). It records `AGNI_SECRETS_MODE=file` and the
  reason, so nothing is downgraded silently. On a headless Linux server you can
  give the vault a passphrase instead: put it in a file only you can read and
  set `AGNI_VAULT_PASSPHRASE_FILE` to that file when you run `agni setup`,
  `agni vault migrate` and `agni service install`. `service install` then hands
  the file to the service as a systemd credential
  (`LoadCredential=agni-vault-passphrase:<file>` in the unit it writes).
- **Existing installs keep their mode.** A home made before the vault, or one
  with data or credentials in `config.env`, stays in file mode until you run
  `agni vault migrate`. Nothing is moved on its own.
- **A vault whose keystore goes away stops the server.** Agni refuses to start
  and says why; it never falls back to plaintext keys.
- `agni doctor` shows the active mode, the keystore backend (or why there is
  none), and whether the server can unlock the vault (it exits 1 when it cannot;
  on a headless server it reads the service's passphrase file from the
  installed systemd unit). It warns when file mode is active on a machine where
  the vault would work, and when `vault.bin` exists but no mode is recorded. `agni vault status|list|migrate|export` manage the vault; `export --yes`
  goes back to plaintext.
- A server you start by hand on a home that never went through `agni setup` (a
  dev checkout) has no recorded mode and runs in file mode; set
  `AGNI_SECRETS_MODE=vault` to use the vault there.

Everything lives under `AGNI_HOME` (default `~/.agni`): `config.env`,
`providers.json`, `plugins.json`, `vault.bin` (vault mode), `data/agni.sqlite` (with `backups/`, `share/`,
`attachments/`, `chatgpt/`), `scratch/`, `skills/`, `logs/agni.log`, and
`run/agni.pid`. Old files are moved there automatically on first run. Per-file
overrides (`AGNI_DB_PATH`, `AGNI_PID_PATH`, `AGNI_LOG_PATH`, `AGNI_PLUGINS_PATH`,
`AGNI_PROVIDER_CONFIG_PATH`, `AGNI_SCRATCH_DIR`, `AGNI_SHARE_DIR`) still work.
Model choices changed in the Mac app are stored in `~/.agni/providers.json`
(mode 600). Provider API keys are kept as described under
[Where secrets are kept](#where-secrets-are-kept) (the vault, or `config.env` in
file mode); the JSON file contains model IDs only. `AGNI_HOME` itself must be set in the process environment.

## Phases (plan)

This is the plan from the blueprint. It is not a status report.

| Phase | Scope | Proof |
| --- | --- | --- |
| P0 | Server + instant lane, CLI test client | p50 ≤ 1.5 s over the socket, streaming deltas, failover on 429 |
| P0.5 | Daemon lifecycle, chat REPL, background jobs | `daemon start`, `chat` streams, scheduled job lands in a thread + notify |
| P1 | Mac app (SwiftUI): pairing, threads, streaming, resync | Kill app mid-turn, reopen, turn resumes |
| P2 | Memory/links/tasks stores + 07:55 brief via ntfy | Capture → retrieve → approve from a notification |
| P3 | ACP (codex-acp) + MCP (REA) | Repo task streams from Codex into the same thread UI |
| P4 | Gmail (IMAP/SMTP app password) + calendar ICS | Approved draft sends; brief shows a real event |
| P5 | Android + bb-1 + polish | Phone over Tailscale; server survives a reboot |

P0–P2 is the "faster than Hermes and usable daily" milestone.

## Rules

- `packages/protocol` is the contract. Change frames there; bump
  `PROTOCOL_VERSION` on breaking changes and update `docs/protocol.md`.
- Free-first routing. Provider keys live server-side only — never in the repo,
  never in the apps.
- Every tool call is checked by the policy engine (`apps/server/src/policy/engine.ts`)
  before it runs. Anything that shells out, writes files outside scratch, sends
  mail, or pays money needs the owner's approval. The one exception is a send from
  Agni's own mailbox, which runs without asking in a run that has read nothing
  from outside.
- No IDE features, ever. Repo-shaped work is planned for ACP harnesses (P3), not built.
- `bun run typecheck`, `bun run test`, and `bun run test:web` pass before a change is called done. `bun run check` runs them with the evals.

### Writing messages and attaching files (web)

Enter sends; Shift+Enter adds a new line. Messages support Markdown, including
code blocks with a copy button, tables, and checklists. Use **+ → Attach files**,
drop files onto the composer, or paste an image. The draft keeps files when an
upload fails so it can be retried. Attachments remain available in chat history.

Supported: PNG/JPEG/WebP, UTF-8 text/source files, and PDFs with selectable text.
Up to five files per message, 10 MB each; large text/PDF inputs have extraction
and model-context limits. Scanned PDFs require OCR, which is not included.
To enable image analysis, set `AGNI_VISION_MODELS` in the server's `config.env` to the
exact IDs of already-configured models that support image input. A missing
vision model is reported before the message is sent; text/PDF uploads do not
need vision. Provider keys continue to live only on the server.

After an update, restart the daemon (`bun run daemon restart`)
and Vite (`Ctrl+C`, then `bun run web`). Database migrations apply automatically at
server startup. The native SwiftUI app does not have attachment controls yet.
