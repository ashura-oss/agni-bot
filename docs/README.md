# Docs index

Which docs to trust, and which are only history. Statuses were checked against
the code on `dev` on 2026-11-17. Where a doc and the code disagree, the code
describes the behaviour and the doc is wrong.

Read these first:

1. [`../AGENTS.md`](../AGENTS.md): what Agni Bot is, its terms, hard rules, traps, and where the code lives.
2. [`architecture.md`](architecture.md): the system map, including the policy gate and the secrets vault.
3. [`protocol.md`](protocol.md): the wire contract (protocol v2).
4. [`plugins.md`](plugins.md) and [`routines.md`](routines.md): outside accounts and scheduled work.
5. [`blueprint-v3.html`](blueprint-v3.html): the original plan. Use it for intent, not for status.

## Status key

- **current**: maintained for this fork. Matches the code as checked on the date above.
- **upstream history**: written for the friends' project, or an old plan. Kept
  unchanged so merges from upstream stay simple. It is not a statement of what
  this fork builds. Check the code before you quote it.

## Every file in docs/

| File | Status | What it is |
| --- | --- | --- |
| `README.md` | current | This index. |
| `architecture.md` | current | System map: clients, server, jobs, task lane, policy gate, stores, secrets and audit, plugins. |
| `protocol.md` | current | Wire contract for protocol v2: frames (including the policy and memory frames), limits, error codes, and who may connect. |
| `plugins.md` | current | Connected accounts and MCP servers: catalog, capability modes, trusted and pinned MCP tools. |
| `routines.md` | current | Scheduled routines: preflight checks, allowed tools, limits, event triggers. |
| `agni-context-memory-spec.md` | upstream history | Upstream context and memory spec. |
| `backend-improvement-plan.md` | upstream history | Upstream backend improvement plan. Its bug list may be stale. |
| `blueprint-v3.html` | upstream history | Original product plan. Section 10 has a status column dated 2026-10-26. |
| `gmail-plan.html` | upstream history | Upstream Gmail plan. |
| `google-oauth-setup.html` | upstream history | Upstream Google OAuth setup notes. |
| `harness-review.md` | upstream history | Upstream design for a nightly harness review. |
| `homepage.html` | upstream history | Upstream homepage draft. Not audited. |
| `issues-to-fix.md` | upstream history | Upstream issue list. Entries need checking against the code. |
| `p2-plan.md` | upstream history | Historical P2 plan. |
| `plugins-plan.html` | upstream history | Upstream plugin plan. Use `plugins.md` for status. |
| `remaining-work.md` | upstream history | Upstream list of remaining work. Not line-checked. |
| `research-context-management.md` | upstream history | Upstream research brief on context management. |
| `routines-plan.md` | upstream history | Plan for the routines build. Its sections describe the build as it was made. Use `routines.md` for status. |
| `ui-design.md` | upstream history | Upstream UI design notes. |
| `ui-mocks.html` | upstream history | Upstream UI mocks. One bot label is a lane name, not a bot. |

## Other locations

These were audited on 2026-10-26. The rows marked "not re-checked" were not
checked again on 2026-11-17.

| Path | Status | Notes |
| --- | --- | --- |
| `README.md` | current | Repo intro, quickstart, and dev commands. Updated 2026-11-17. |
| `AGENTS.md` | current | Codebase map and engineering rules for agents. Updated 2026-11-17. |
| `apps/web/README.md` | current, not re-checked | Run and smoke commands. |
| `apps/mac/README.md` | current, not re-checked | Mac client (SwiftUI). |
| `apps/mac/DESIGN.md` | not audited | Design notes. |
| `apps/app/README.md` | planned | Tauri client. No app code exists yet. |
| `apps/landing/index.html` | current, not re-checked | Landing page. |
| `apps/public/index.html`, `apps/public/privacy.html` | not audited | The privacy page names integrations (Google, Granola, Notion). It should not imply Slack or Discord. |
| `infra/README.md`, `infra/npm/README.md` | not audited | Install and deploy notes. |
| `infra/env.example` | not audited | Environment template. It does not list every variable the code reads (for example `AGNI_KEYSTORE`). |
| `extensions/README.md` | placeholder | The extension loader is not built. |
| `thoughts.md` | partly stale | Mac pairing notes. |
| `bug.md` | not audited | Open bug list named in `AGENTS.md`. |
| `.deepsec/README.md`, `.deepsec/AGENTS.md` | not product docs | Security-scan workspace. |
| `legacy/` | legacy | Superseded material. Not product facts. |

## Known gaps

- No doc covers the `tools/audit/` peer-memory audit script.
- The shared seams from the early prep (`redact()`, the audit sink, `ToolMeta`,
  the usage recorder, and the secret-name classifier) are live now.
  `architecture.md` describes them. It also lists the stored text paths that
  are not yet redacted before storage.
- A local `.env` that still sets `AGNI_DB_PATH=data/...` keeps the old database location.
