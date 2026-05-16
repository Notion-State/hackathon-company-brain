# `ingest-slack`

Notion Worker that syncs Slack threads from all public, non-shared channels into two managed Notion databases:

- **`Slack Channels`** — one row per eligible channel (name, topic, member count, creator, etc.)
- **`Slack Messages`** — one row per top-level thread, with the full reply chain rendered into the page body

Each Messages row is related (two-way) to its Channel row via Notion's `relation` property.

Part of the [Company Brain](../../REQUIREMENTS.md) project; mirrors the architecture of `workers/ingest-fireflies`.

## What it exposes

| Capability | Database | Mode | Schedule | Purpose |
|---|---|---|---|---|
| `slackChannelsSync` | `Slack Channels` | `replace` | `1h` | Discovers eligible channels (public, non-shared, non-archived), auto-joins any the bot isn't in, writes one row per channel. Replace-mode mark-and-sweep removes channels archived/removed since last cycle. |
| `slackBackfill` | `Slack Messages` | `replace` | `manual` | Per channel, walks `conversations.history` back `SLACK_BACKFILL_DAYS` days, assembles each thread via `conversations.replies`. Refreshes reactions. Trigger after deploy and any time you want to clean up drift. |
| `slackDelta` | `Slack Messages` | `incremental` | `5m` | Per-channel `lastActivityTs` cursor with a 60-second consistency buffer. Picks up edits, new replies, and new threads. Does not pick up deletes (backfill's job). |

The bot calls `conversations.join` from the channels sync only — the messages syncs trust it has run and skip channels where `is_member` is false.

## Required env

| Var | Required? | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | `xoxb-...` from the app's "OAuth & Permissions" page. |
| `SLACK_BACKFILL_DAYS` | no | `30` | Backfill window. Also seeds the first-run delta cursor. Clamped to [1, 3650]. |

The internal-domain list (drives `Internal Participants` / `Internal Creator` matching) is hardcoded to `notionstate.com` in `src/index.ts` — see the [fireflies README](../ingest-fireflies/README.md#required-env) for the same rationale.

**No `NOTION_API_TOKEN` is needed.** `Builder.people(...emails)` accepts emails as variadic strings and Notion resolves them to workspace users at sync time — we don't make any Notion API calls from this worker.

See `.env.example`.

## Required Slack scopes (bot)

| Scope | Why |
|---|---|
| `channels:read` | List public channels via `conversations.list`. |
| `channels:history` | Read public-channel messages and thread replies. |
| `channels:join` | Auto-join discovered channels. Slack posts a visible "X has joined the channel" message — there is no API to suppress this. |
| `users:read` | Resolve user IDs → display names (`users.info`). |
| `users:read.email` | Pull emails for internal-domain matching. |
| `team:read` | One-time `team.info` call for the workspace subdomain used in channel deep-link URLs. |

## Slack app setup

1. Create a Slack app at https://api.slack.com/apps → "From scratch".
2. Pick "Not distributed" (internal app — keeps you on the older Tier-3 quotas; the new May 2025 rate-limit tightening targets Marketplace/distributed apps).
3. Under "OAuth & Permissions", add the six bot scopes above to "Bot Token Scopes".
4. Click "Install to Workspace". Copy the resulting `xoxb-...` bot token.
5. `ntn workers env set SLACK_BOT_TOKEN=xoxb-...` (or write to `.env` locally).

The first `slackChannelsSync` run will auto-join the bot to every eligible public channel. If your workspace restricts who can join channels, the bot will skip restricted channels and log a warning — those channels' rows will have `Is Member = false`.

## Local development

```bash
cd workers/ingest-slack
npm install
cp .env.example .env
# edit .env with your SLACK_BOT_TOKEN

npm run check        # TypeScript
npm test             # vitest unit suite
npm run test:watch   # iterative
```

## Deploy

```bash
ntn workers deploy --name ingest-slack         # first time
ntn workers env set SLACK_BOT_TOKEN=xoxb-...
ntn workers env set SLACK_BACKFILL_DAYS=30     # optional
```

After the first deploy, re-deploy with just `ntn workers deploy`.

## Verifying a sync

```bash
# Dry-runs locally (use .env, do not write to Notion)
ntn workers sync trigger slackChannelsSync --preview --local
ntn workers sync trigger slackBackfill     --preview --local

# Dry-run against the deployed worker
ntn workers sync trigger slackDelta --preview

# First real channels sync (writes to Notion)
ntn workers sync state reset slackChannelsSync
ntn workers sync trigger slackChannelsSync

# First real messages backfill
ntn workers sync state reset slackBackfill
ntn workers sync trigger slackBackfill

# Watch health
ntn workers sync status
```

Use `/sync` in Notion to bind each capability to a database location in your workspace. The first time, run `/sync` against `slackChannelsSync` (which creates the `Slack Channels` database), then run `/sync` again against `slackBackfill` (which creates the `Slack Messages` database). Notion holds the relation between them as long as both databases live in the same worker — which they do.

`--preview` shows the change records the sync would emit without writing them. Use it to validate property shapes, page-body markdown, and the relation reference shape before letting the live cycle run.

## Source layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry point: declares both databases, the shared pacer, and all three syncs. |
| `src/slack.ts` | `createSlackClient(token, pacer)` factory wrapping `@slack/web-api`. Normalizes responses, classifies errors, retries on rate-limit. Tested with a stubbed `WebClient`. |
| `src/channels.ts` | `discoverEligibleChannels` — paginates list, applies the eligibility filter, optionally auto-joins. Pure / tested. |
| `src/threads.ts` | `assembleThread` — fetches full reply chain, filters system events, drops tombstones. Pure / tested. |
| `src/lookups.ts` | Lazy-cached Slack user + bot identity lookups. Tested with a stub client. |
| `src/render-channels.ts` | Channel → Notion property map + minimal page-body markdown. Pure / tested. |
| `src/render-threads.ts` | Thread → Notion property map + thread page body. Includes Slack mrkdwn → commonmark conversion (mentions, channel refs, links, bold/italic/strike). Pure / tested. |
| `src/internal-domains.ts` | `INTERNAL_DOMAINS` parsing + email-domain helpers (copied verbatim from `workers/ingest-fireflies/src/internal-domains.ts`). |
| `src/sync-state.ts` | Pure state-machine helpers for all three syncs + `clampInt`. Tested. |
| `src/system-events.ts` | Set of Slack message subtypes (`channel_join`, `pinned_item`, etc.) to filter out, plus tombstone detector. Tested. |
| `src/markdown.ts` | Shared `escapeMarkdown` helper. |
| `src/fixtures/` | Hand-built Slack message fixtures for renderer and thread-assembly tests. |

## Consumed by

- (planned) `workers/agent-categorizer` — reads from `Slack Messages`, classifies items.
- (planned) `workers/agent-summarizer` — produces digest pages from clusters of threads.

## Known limitations

- **Backfill window is hard.** Threads whose parent is older than `SLACK_BACKFILL_DAYS` are not pulled, even if they had recent activity. Increase the env if you need a longer history.
- **Edits to messages older than the delta window are not seen.** `conversations.history` filters by parent `ts`, not `edited.ts`. The manual backfill catches them.
- **No real-time deletes (messages).** A deleted Slack message sticks in Notion until the next messages backfill mark-and-sweep.
- **No real-time deletes (channels).** An archived channel disappears from `Slack Channels` at the next channels-sync cycle (≤1h). Its message rows persist until the next messages backfill.
- **Reaction drift.** Counts captured at the most recent backfill or delta thread-refetch. Threads with no new activity drift between backfills.
- **Auto-join is visible.** Slack posts "X has joined the channel" — no API to suppress.
- **New-channel latency.** Worst case ~1h + 5min from channel creation to first message ingestion (next channels sync joins, next delta picks up).
- **Single workspace in v1.** The `Slack Messages` `Record ID` reserves room for a future `${workspaceId}:` prefix.
- **Polling only.** Slack Events API (webhooks) deferred — would cut delta latency from ~5m to ~5s.
- **Archived channels not retained.** Replace-mode mark-and-sweep removes them. Flip in a future revision by switching to `exclude_archived: false` + keeping the `Is Archived` checkbox accurate.
- **Mrkdwn rendering inside thread bodies is not markdown-escaped.** Slack message content is converted to commonmark but not subsequently escaped — a user can inject markdown (e.g., a fake link) into their message and it will render. Acceptable for a Notion target (no XSS surface); structural integrity of the page is preserved because the surrounding template uses our own escaped strings.
