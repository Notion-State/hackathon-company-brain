# `ingest-client-notion`

Notion Worker that syncs **feature-request pages from multiple client Notion workspaces** into a single managed Notion database `Client Feature Requests`. First Notion-to-Notion sync in the [Company Brain](../../REQUIREMENTS.md) project — every other ingest worker pulls from a non-Notion API.

## What it exposes

| Capability | Type | Schedule | Purpose |
|---|---|---|---|
| `clientFeatureRequestsBackfill` | sync (`replace`) | `manual` | Full sweep per client. Replace mode mark-and-sweeps deletions (archived/in-trash pages on the client side disappear from our DB on the next backfill). Trigger after onboarding a client and on a slow operator cadence (weekly) to reap deletes. |
| `clientFeatureRequestsDelta` | sync (`incremental`) | `5m` | Per-client `last_edited_time` cursor with a 60-second consistency buffer. Deletes are NOT picked up here — only the backfill catches them. |

Both write to the same database (`Client Feature Requests`). Primary key is composite `Record ID = ${clientId}:${pageId}` so two clients can mirror unrelated trackers without colliding. See [SCHEMA.md](../../SCHEMA.md) for the full property table and the canonical source-side schema the client must conform to.

## Required env

| Var | Required? | Default | Description |
|---|---|---|---|
| `CLIENT_NOTION_TOKEN_<ID>` | yes (per client) | — | Internal-integration token from the client's Notion workspace. Pair with `..._DB_ID_<ID>`. |
| `CLIENT_NOTION_DB_ID_<ID>` | yes (per client) | — | Id of the client's Feature Requests database (uuid from the database URL). |
| `CLIENT_NOTION_BACKFILL_DAYS` | no | `30` | Days to look back when seeding a new client's delta cursor on first run. Ignored by the backfill. Clamped to [1, 3650]. |

See `.env.example`.

Setting a `_TOKEN_<ID>` without a `_DB_ID_<ID>` (or vice versa) throws at module init. This is deliberate — partial config is the most common onboarding mistake and we want it caught loudly.

## Source-side schema (what each client's DB must contain)

The strict canonical schema lives in [SCHEMA.md](../../SCHEMA.md#client-feature-requests-managed-by-workersingest-client-notion) and is mirrored from the project schema reference in Notion. Required properties on each client's database:

- A title-typed property (any name; we discover it by `type === "title"`)
- `Status` (status, with groups `To-do` / `In progress` / `Complete`)
- `Priority` (select: Critical / High / Medium / Low)
- `Complexity`, `Effort` (select: High / Medium / Low)
- `Projection` (select: Company / Leadership / Department / Team / Individual)
- Optional: `ID` (unique_id), `Description` (rich_text), `Submitter` (people), `Type` (select), `Team` / `Dependencies` (rich_text), `Assigned Owner` (select), `POC` (people), `Proposed Owner` (formula), `Support Owner` / `Technical Lead` (single person)

Missing optional properties don't break the sync — readers fall back gracefully. Missing required ones won't crash either, but the resulting rows will be incomplete and downstream agents will likely treat them as low-confidence.

## Client onboarding runbook

For each new client:

1. **Client creates an internal integration** at https://www.notion.so/profile/integrations/internal in their workspace. Capabilities: "Read content" + "Read user information including email addresses" (the latter lets us populate `Submitter` / `POC` with email).
2. **Client shares the Feature Requests database with the integration**: open the database → top-right `...` → `Connections` → add the integration.
3. **Client confirms the database matches the canonical schema** (see SCHEMA.md). Easiest path: have them duplicate the template page if one exists.
4. **Client sends us the integration token (`ntn_...` or `secret_...`) and the database URL.** Extract the database id (uuid) from the URL.
5. **Operator wires it up:**
   ```bash
   ntn workers env set CLIENT_NOTION_TOKEN_<ID>=<token>
   ntn workers env set CLIENT_NOTION_DB_ID_<ID>=<dbId>
   ntn workers env push
   ntn workers deploy           # redeploy so the new pacer + Client schema option register
   ```
6. **Verify, then run:**
   ```bash
   ntn workers sync trigger clientFeatureRequestsBackfill --preview   # dry-run
   ntn workers sync trigger clientFeatureRequestsBackfill             # for real
   ```

## Operational notes

- **Archived / in-trash pages.** `dataSources.query` excludes them by default. Deletions in the client workspace are NOT picked up by the delta sync — they're reaped by the backfill's mark-and-sweep. Run the backfill on a slow cadence (weekly is fine) to keep the internal DB in sync with client-side deletes.
- **`last_edited_time` updates on every edit.** Expect occasional re-syncs of unchanged-looking rows; that's Notion's index doing its job.
- **Page body cost.** Each row fetched in a backfill incurs 1 query call + 1 block-list call (more if the page has nested toggles/columns at depth ≤2). With the 3 req/s per-client pacer, a 500-page backfill runs ~5 minutes per client.
- **Token rotation.** Revoke the old token at the client's integration page, generate a new one, `ntn workers env set` + `env push`, redeploy.
- **Bad token / removed access.** If the integration loses access to the DB (401/403/404 from Notion), the active client is skipped for the rest of the cycle with a `console.warn`. Other clients keep syncing. Re-share the DB with the integration and trigger another cycle.

## Rate limits

- Notion's documented per-integration limit is "an average of 3 requests per second." Each client gets its own integration, so 3 req/s per client is the literal ceiling.
- Per-client pacer: `worker.pacer("clientNotion:<id>", { allowedRequests: 3, intervalMs: 1000 })`.

## Local development

```bash
cd workers/ingest-client-notion
npm install
cp .env.example .env
# edit .env: add CLIENT_NOTION_TOKEN_<ID> and CLIENT_NOTION_DB_ID_<ID> for a sandbox client

npm run check          # TypeScript
npm test               # vitest unit suite
npm run test:watch     # iterative
```

## Deploy

```bash
ntn workers deploy --name ingest-client-notion    # first time
ntn workers env push                              # push .env to the deployed worker
```

After the first deploy you can re-deploy with just `ntn workers deploy`.

## Verifying a sync

```bash
ntn workers sync trigger clientFeatureRequestsBackfill --preview
ntn workers sync trigger clientFeatureRequestsDelta --preview

ntn workers sync state reset clientFeatureRequestsBackfill   # restart from scratch
ntn workers sync trigger clientFeatureRequestsBackfill        # real run

ntn workers sync status                                       # health
```

## Source layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: database declaration, per-client pacers + Notion clients, backfill sync, delta sync. |
| `src/clients.ts` | Enumerates clients from env (`CLIENT_NOTION_TOKEN_<ID>` + `CLIENT_NOTION_DB_ID_<ID>`). Pure / tested. |
| `src/notion.ts` | `createClientNotion(token)` factory wrapping `@notionhq/client`. Lazy DB → data-source resolution; bounded block-tree fetch. |
| `src/render.ts` | Source page → managed-DB property values + body markdown header. Pure / tested. |
| `src/blocks.ts` | Block tree → markdown (depth-bounded, 50KB cap). Pure / tested. |
| `src/sync-state.ts` | Pure state-machine helpers for backfill and delta cycles. Tested. |
| `src/fixtures/` | Hand-built page and block samples used by tests. |

## Consumed by

- (planned) `workers/agent-categorizer` — classifies and clusters Client Feature Requests alongside ingest data from Fireflies / Slack / Loom.

## Known limitations

- **Polling only.** Notion has webhooks that would cut latency; deferred.
- **Page-body recursion is depth-2.** Toggles-inside-toggles below depth 2 render as `_[nested children truncated]_`. Rich Feature Request descriptions rarely nest that deep in practice.
- **People properties** are stored as `"Name <email>"` rich_text (not `Schema.people`) because the source users don't exist in our internal workspace. Email may be missing for users outside the integration's workspace or guests — falls back to bare name.
- **`Type` and `Assigned Owner`** are stored as `rich_text` rather than `select` since option sets vary across clients and the SDK requires pre-declared select options.
- **Schema drift detection** is deferred. A future preflight could call `databases.retrieve` per backfill and warn on missing canonical properties.
