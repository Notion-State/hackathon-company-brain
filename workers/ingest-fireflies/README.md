# `ingest-fireflies`

Notion Worker that syncs **Fireflies.AI** meeting transcripts into a managed Notion database `Meeting Transcripts`. First ingest worker in the [Company Brain](../../REQUIREMENTS.md) project.

## What it exposes

| Capability | Type | Schedule | Purpose |
|---|---|---|---|
| `firefliesBackfill` | sync (`replace`) | `manual` | Backfills the last `FIREFLIES_BACKFILL_DAYS` (default 30) per account. Replace mode mark-and-sweeps deletions. Trigger after deploy and any time you want to clean up drift. |
| `firefliesDelta` | sync (`incremental`) | `5m` | Per-account cursor on meeting date with a 1-hour consistency buffer (transcripts can take time to finalize). |

Both write to the same database (`Meeting Transcripts`). Primary key is composite `Record ID = ${accountId}:${transcriptId}` so multiple accounts that share a meeting do not race on overwrites. See [SCHEMA.md](../../SCHEMA.md) for the full property table.

## Required env

| Var | Required? | Default | Description |
|---|---|---|---|
| `FIREFLIES_API_KEY` | yes (or a `FIREFLIES_API_KEY_<ID>` variant) | — | Default account's API key. Get it from [Fireflies → Integrations → Custom Fireflies](https://app.fireflies.ai/integrations/custom/fireflies). |
| `FIREFLIES_BACKFILL_DAYS` | no | `30` | How far back the backfill (and first-run delta cursor) reaches. Clamped to [1, 3650]. |
| `NOTION_API_TOKEN` | required for `Companies` column | — | Internal-integration token. Create at [Notion integrations](https://www.notion.so/profile/integrations/internal); grant access to the Meeting Transcripts DB *and* the Companies DB. Without it, the `Companies` column stays empty but the sync still runs. (Sync capabilities are not pre-authenticated by the workers platform; only tool capabilities invoked by Custom Agents get an automatic token.) |
| `COMPANIES_DATABASE_ID` | yes | — | Notion database id of the Companies DB (attendee email domain → company name; drives the `Companies` column). Read from env and **required** — the worker throws at startup if unset. `NOTION_API_TOKEN` must also grant access to this DB for the column to populate. Use the id (with or without dashes) from the DB's URL. |
| `FIREFLIES_API_KEY_<ID>` | no | — | Additional Fireflies accounts. The `<ID>` becomes the account id (lowercased). Example: `FIREFLIES_API_KEY_ACME` → account id `acme`. |

The internal-domain list (`INTERNAL_DOMAINS`, our own `notionstate.com`) is hardcoded in `src/index.ts` — it's our org domain rather than a per-environment value, and pinning it keeps a deploy-time misconfig from silently disabling the Internal/External classification. The tenant-specific Companies database id is **not** hardcoded; it's read from `COMPANIES_DATABASE_ID` (see the table above).

See `.env.example`.

## Multi-account ingest

v1 is wired for a single account but designed so adding more accounts is a config change, not a code change. To add one:

```bash
ntn workers env set FIREFLIES_API_KEY_ACME=<key>
ntn workers deploy   # redeploy so the new pacer + Account schema option are wired
```

Each account gets its own pacer (50 req/min, safety margin under Fireflies' 60/min Business limit), so rate budgets do not interfere. Each account's delta cursor advances independently.

## Local development

```bash
cd workers/ingest-fireflies
npm install
cp .env.example .env
# edit .env with your FIREFLIES_API_KEY

npm run check          # TypeScript
npm test               # vitest unit suite
npm run test:watch     # iterative
```

## Deploy

```bash
ntn workers deploy --name ingest-fireflies     # first time
ntn workers env set FIREFLIES_API_KEY=<key>
ntn workers env set FIREFLIES_BACKFILL_DAYS=30 # optional
```

After the first deploy you can re-deploy with just `ntn workers deploy` (no `--name` flag).

## Verifying a sync

```bash
# Dry-run locally (uses .env, does not write to Notion)
ntn workers sync trigger firefliesBackfill --preview --local

# Dry-run against the deployed worker
ntn workers sync trigger firefliesDelta --preview

# First real backfill (writes to Notion)
ntn workers sync state reset firefliesBackfill
ntn workers sync trigger firefliesBackfill

# Watch health
ntn workers sync status
```

`--preview` shows the change records the sync would emit without writing them. Use it to validate property shapes, page-body markdown, and pagination before letting the live cycle run.

## Source layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry point: declares the database, per-account pacers + clients, backfill sync, delta sync. |
| `src/accounts.ts` | Enumerates accounts from env (`FIREFLIES_API_KEY[_<ID>]`). Pure / tested. |
| `src/fireflies.ts` | GraphQL client factory `createFirefliesClient(apiKey)`. Pure / tested. |
| `src/internal-domains.ts` | `INTERNAL_DOMAINS` parsing + email-domain helpers. Pure / tested. |
| `src/lookups.ts` | Lazy-cached Companies DB lookup (domain → company name). Tested with stub Notion client. |
| `src/render.ts` | Transcript → markdown body + change-record properties (including `NS Talk %` computation). Pure / tested. |
| `src/sync-state.ts` | Pure state-machine helpers for backfill and delta cycles. Tested. |
| `src/fixtures/` | Hand-built transcript samples used by tests. |

## Consumed by

- (planned) `workers/agent-categorizer` — reads from `Meeting Transcripts`, classifies entries.
- (planned) `workers/agent-summarizer` — produces digest pages from clusters of transcripts.

## Known limitations

- **Polling only** in v1. Fireflies has a "Transcription completed" webhook that would reduce latency from `~5m` to `~5s`; deferred to a follow-on task.
- **Per-transcript detail fetch** — each page requires 1 list call + 50 detail calls. With a 50/min pacer, a full page takes ~1 min. Large backfills can take an hour or more.
- **Single-org auth.** If you want individual users to connect their own Fireflies accounts dynamically (vs. an admin adding env-var keys), we'd add OAuth. Out of scope for MVP.
