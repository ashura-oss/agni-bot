# Routines

A routine is a recurring background job owned by one bot. It runs on a cron
schedule in a timezone, and before each run it checks its preflight:

- `http`: fetches the URL and compares the ETag, or a hash of the body.
- `sql`: runs one read-only `SELECT` on the Agni Bot database and hashes the rows.
- `mail`: one IMAP `UNSEEN` search. See Event triggers below.
- `none`: always counts as changed.

When the preflight shows no change, the run is recorded as `skipped_no_delta`
and the bot is not called. Otherwise the bot runs the routine's prompt with a
read-only tool set and reports into a background session in its conversation.
Five failures in a row pause the routine and notify the owner.

## Tools

- `routine_create`: name, prompt, cron, timezone, optional preflight, misfire,
  maxTokens, maxExecutionMs. The preflight is `http`, `mail`, `none`, or a
  named check (`{kind:"check", name, params}`, from the fixed list in
  `apps/server/src/routines/preflight-checks.ts`). A bot cannot write SQL:
  `{kind:"sql"}` is refused.
- `routine_list`: this bot's routines, next run, last outcome.
- `routine_pause`: pause or resume one routine.
- `routine_delete`: delete one routine and its run history.

A routine cannot be created from a turn that started from another bot's message.

## Defaults and limits

| Setting | Default | Limit |
| --- | --- | --- |
| Schedule | required | a cron with a valid timezone; at least 5 minutes between runs |
| Misfire | `run_once` | `skip` drops a run that is more than one period late |
| `maxTokens` | 16,000 | 1 to 16,000 (the task loop's own cap) |
| `maxExecutionMs` | 120,000 | 1 to 600,000 |
| `allowedDomains` | empty | web tools refuse every host; `routine_create` always leaves it empty |
| Preflight | `none` | `sql` must be one read-only `SELECT`, with no `;` and no `WITH` |

A routine run can use only these tools: memory search, transcript search, links
search, tasks list, web search and fetch, mail read, `recall_fact`, and the
skills tools. Mail search and calendar list are added only when the routine has
no `allowedDomains`, so what it reads has no web egress. A routine cannot send
mail, run bash, read or write files (`read_file`, `grep`, and `glob` are not
offered), hand off to another bot, or change jobs or routines.

The allowlist is `ROUTINE_TOOL_ALLOWLIST` in `apps/server/src/routines/run.ts`.

## Known limits

- A named check is a fixed question about Agni's own data, picked by name with typed values. There is no model-written SQL. A routine that held one before the change was paused (migration 63); ask the bot to recreate it with a named check.
- A bot may hold at most 20 routines.
- A state block over 4,096 characters is refused. The prior state is kept and the run records a warning.
- An `http` preflight checks every redirect hop: http or https only, and a public host. It follows at most 5 redirects.

## Not built

Crystallization, webhook triggers, Telegram, Discord and Slack delivery, shell
preflight, USD budgets, and a kernel sandbox.

## Event triggers and templates

- A `mail` preflight (`{kind:"mail", account:"agent"|"owner"}`) is the new-mail
  trigger: pair it with a short cron (5 minutes is the minimum). Each tick does
  one IMAP `UNSEEN` search; the model runs only when an unseen message newer
  than the last run exists. Mail is polled, not IDLE.
- A reply that starts with `NOTHING_TO_REPORT` records the run but sends no
  notify.
- "Check my apps" is seeded paused for `ea` (09, 12, 15, 18 local). Resume it
  with `routine_pause`. It uses `mail_search`, `mail_read` and, if present,
  `calendar_list`. `mail_search` and `calendar_list` are offered only to a
  routine with no `allowedDomains`, so what it reads has no web egress.
- Background jobs run on a pool of `AGNI_JOB_CONCURRENCY` (default 2); only
  `turn`, `routine` and `task.reminder` may overlap with themselves.
- Web Push needs the daemon reachable over https (for example `tailscale
  serve`) or localhost. The VAPID key is `~/.agni/push-vapid.json` (mode 600).
  APNs for the Mac app is not built (needs an Apple key).
