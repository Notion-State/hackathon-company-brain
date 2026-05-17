# `ingest-loom`

Notion Worker that enriches **Loom** videos referenced from an existing Notion database. For each row in the source DB whose `Video URL` property holds a Loom share link, the worker fetches public metadata (title, thumbnail, duration, description, owner, transcript, comment count) and writes one row per source page into a managed Notion database `Loom Videos`.

Part of the [Company Brain](../../REQUIREMENTS.md) project; mirrors the backfill + delta architecture of `workers/ingest-fireflies` and `workers/ingest-client-notion`.

Loom has **no general-purpose REST API** at any tier (Enterprise gates SCIM only). The enrichment surface this worker uses is entirely public and unauthenticated:

- **oEmbed** — `https://www.loom.com/v1/oembed?url=…`. Documented, stable. Title, thumbnail, duration.
- **Public share-page** — OpenGraph + JSON-LD scraped from the share URL. Description, upload date.
- **Public GraphQL** — `https://www.loom.com/graphql`. **Undocumented**; operation names drift. Composite query selects `getVideo` for owner / comment count / description plus `fetchVideoTranscript` for a signed CloudFront URL pointing at the transcript JSON. Controlled by a kill switch.
- **Signed CloudFront transcript JSON** — `https://cdn.loom.com/mediametadata/transcription/<id>-<v>.json?Policy=…`. Fetched immediately after GraphQL on a per-row basis; the URL Policy expires ~5 min after issuance.

## What it exposes

| Capability | Database | Mode | Schedule | Purpose |
|---|---|---|---|---|
| `loomBackfill` | `Loom Videos` | `replace` | `manual` | Full sweep of the source DB. Re-fetches every enrichment. Replace-mode mark-and-sweep removes target rows whose source pages were archived/deleted. Trigger after deploy and periodically to refresh engagement metrics. |
| `loomDelta` | `Loom Videos` | `incremental` | `5m` | Filters the source DB by `last_edited_time` since the cursor (60-second consistency buffer). Re-enriches any source row edited since the last cycle. Does **not** refresh engagement metrics on unchanged rows — that's the backfill's job. |

## Required env

| Var | Required? | Default | Description |
|---|---|---|---|
| `NOTION_API_TOKEN` | yes | — | Internal-integration token used to read the source DB. Create at https://www.notion.so/profile/integrations/internal, then share the source DB with the integration. |
| `LOOM_SOURCE_DATABASE_ID` | yes | `c148c2e3aa554651bd9ca44b1de751d0` | Notion database id whose rows hold the Loom URLs. The provided default targets the production source DB this worker was built for. |
| `LOOM_SOURCE_URL_PROPERTY` | no | `Video URL` | Name of the URL property on each source row that holds the Loom share link. Override if pointing at a clone with a different column name. |
| `LOOM_ENABLE_GRAPHQL` | no | `true` | Kill switch for the undocumented public GraphQL endpoint (owner info, comment count, and the signed transcript URL — without GraphQL we can't fetch transcripts either). Set to `false` if Loom changes their schema — Core metadata (oEmbed + share-page scrape) still populates. |

See `.env.example`.

## Notion integration setup

1. Create an internal integration at https://www.notion.so/profile/integrations/internal.
2. Ensure it has **Read content** capability. (Write content is not needed — this worker only reads the source DB; writes go to the managed `Loom Videos` DB through the sync mechanism, which has its own permissions.)
3. Copy the integration token (`ntn_…`).
4. In Notion, open the source database (`c148c2e3aa554651bd9ca44b1de751d0`), click `…` → `Connections` → add the integration.
5. `ntn workers env set NOTION_API_TOKEN=ntn_...` (or write to `.env` locally).

## Local development

```bash
cd workers/ingest-loom
npm install
cp .env.example .env
# edit .env with your NOTION_API_TOKEN

npm run check        # TypeScript
npm test             # vitest unit suite
npm run test:watch   # iterative
```

## Deploy

```bash
ntn workers deploy --name ingest-loom         # first time
ntn workers env set NOTION_API_TOKEN=ntn_...
ntn workers env set LOOM_SOURCE_DATABASE_ID=c148c2e3aa554651bd9ca44b1de751d0
# optional:
ntn workers env set LOOM_SOURCE_URL_PROPERTY="Video URL"
ntn workers env set LOOM_ENABLE_GRAPHQL=true
```

After the first deploy, re-deploy with just `ntn workers deploy`.

## Binding the syncs in Notion

Use the `/sync` slash command in Notion to bind each capability to a destination in your workspace. Run `/sync` once and pick `loomBackfill`; the runtime provisions the managed `Loom Videos` database from the declared schema. Run `/sync` again and pick `loomDelta` — both syncs write to the same database, so Notion reuses it.

`--preview` (CLI) shows the change records the sync would emit without writing them. Use it to validate property shapes and the page-body markdown before letting the live cycle run.

## Verifying a sync

```bash
# Dry-runs locally (use .env, do not write to Notion)
ntn workers sync trigger loomBackfill --preview --local
ntn workers sync trigger loomDelta    --preview --local

# Dry-run against the deployed worker
ntn workers sync trigger loomBackfill --preview

# First real backfill (writes to Notion)
ntn workers sync state reset loomBackfill
ntn workers sync trigger loomBackfill

# Watch health
ntn workers sync status
```

## Source layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry point: declares the managed DB, five pacers (Notion + four Loom surfaces), and both syncs. |
| `src/loom.ts` | `createLoomClient` — four independent fetchers (`fetchOEmbed`, `scrapeSharePage`, `fetchGraphQL`, `fetchTranscriptJson`). Each catches failures and returns a tagged-union status. `parseVideoId` URL parser. Pure helpers `parseIso8601Duration`, `parseSharePageHtml`, `normalizeGraphqlResponse`, `normalizeTranscriptJson` are exported for tests. |
| `src/source-db.ts` | `listVideoRows` — paginates the source Notion DB via `databases.retrieve` + `dataSources.query`, yields normalized `{ pageId, pageUrl, videoUrl, lastEditedTime }` rows. Skips rows with empty `Video URL`. Caches resolved data source id per process. |
| `src/enrich.ts` | `composeEnrichment` / `toChangeProperties` / `renderVideoMarkdown` / `pickStatus` / `mergeFields` — pure composition of source row + enrichment results into Notion change properties + page-body markdown. |
| `src/sync-state.ts` | Pure state-machine helpers for `loomBackfill` (cursor) and `loomDelta` (last_edited_time watermark + within-cycle cursor + 60s buffer). |
| `src/fixtures/` | Hand-built fixtures for share-page HTML, oEmbed responses, and GraphQL responses. |

## Consumed by

- (planned) `workers/agent-categorizer` — reads from `Loom Videos`, classifies videos by topic / customer / action.
- (planned) `workers/agent-summarizer` — produces digest pages summarizing groups of related videos.

## Known limitations

- **GraphQL is best-effort.** Owner info, comment count, and the signed transcript-JSON URL all flow through Loom's undocumented public GraphQL endpoint. Operation names drift — yt-dlp ships periodic fixes. If GraphQL starts failing, set `LOOM_ENABLE_GRAPHQL=false` to keep Core metadata flowing while you investigate (you lose transcripts and owner info, not titles/thumbnails).
- **View counts are not reachable.** Loom's public GraphQL exposes no Query field that resolves the `VideoViewCounts` cache entries the web UI uses; the `View Count` column was removed from the schema in v1.
- **Owner email is usually empty.** Loom only returns `owner.email` for owners who chose to expose it publicly.
- **Transcript URL is short-lived.** The signed CloudFront URL from `fetchVideoTranscript` carries a ~5-minute Policy expiry. The worker fetches the JSON immediately per row; never batch GraphQL responses and drain transcripts later, or the rear of the queue will 403.
- **Speaker labels are not surfaced.** Loom's transcript JSON has no speaker field; cues render as `**[M:SS]** {text}`.
- **Comment counts drift between backfills.** `loomDelta` only re-enriches a source row when it's edited in Notion; comment counts on Loom can change without touching the source row. Trigger `loomBackfill` periodically to refresh.
- **Private / deleted videos are kept, not skipped.** Rows are written with `Sync Status = Private` or `Unavailable` and minimal fields. That preserves a 1:1 mapping with the source DB so downstream agents see "what was attempted" rather than silently dropping rows.
- **Empty `Video URL` rows are skipped.** No target row is created for source rows without a Loom URL.
- **Password-protected videos are not supported.** They'd need per-video credentials, which is out of scope for v1.
- **No write-back to the source DB.** This worker only reads the source DB and writes to its own managed `Loom Videos` DB.
- **Single source DB in v1.** The primary key is the bare Notion page id — if a future iteration adds a second source DB, prefix it with a database id to avoid collisions.
- **Polling only.** No Loom webhooks — new uploads in the source DB surface within ≤5 min of the source row being saved.
