# Requirements

What we're building, why, and what's in scope. Update this doc as scope changes.

## Goal

A Notion-native **Company Brain**: synced source-of-truth meeting/communication data from third-party tools (Fireflies.AI, Slack, Loom), analyzed by agent workers, surfaced for human review in a shared Notion approval database, and selectively pushed to a client's Notion workspace.

All ingest, analysis, and delivery runs on **Notion Workers** so it stays inside the same governance, auth, and observability surface as the rest of Notion.

## Why

- Teams already work in Notion. Pulling raw transcripts / messages / videos into the same workspace makes them addressable as first-class structured data.
- Agents that summarize / categorize / extract action items need stable, queryable inputs — not freeform documents.
- A staged "review then push" flow lets a human approve what reaches the client's Notion before it ships.

## In scope (MVP — this iteration)

| Component | Status | Notes |
|---|---|---|
| `workers/ingest-fireflies` | **Building now** | Pulls meeting transcripts from Fireflies.AI into a managed Notion DB `Meeting Transcripts`. Backfill + delta syncs. Multi-account ready (one Fireflies API key in v1; abstractions handle N keys). |
| `workers/push-to-client` | **Building now** | Exposes a `pushToClient` worker tool with a `docType` discriminator that creates a single page in one of three canonical [Transformation Hub](https://www.notion.so/d931147211b445d9b62b0fd66cf5ff2b) destination databases per client: `Docs`, `Status Updates`, or `Deliverables`. Per-client internal-integration tokens (one `ntn_...` per client, scoped to all three destination DBs the client shares with the integration); no OAuth in MVP. Each destination is the canonical Transformation Hub schema plus a `Brain ID` rich_text augmentation we publish for idempotency — destination-side query, no state in our workspace. Push-once-read-only: a second push for the same `(brainId, docType)` returns `already_pushed` without writing. Relations (Docs `Project`, Status Updates `Event`) are not set in MVP — the client links them manually. `Presenter` on Status Updates is best-effort via email → `users.list` resolution; unresolved → property empty with a warning. Per-client `staging`/`production` mode; production pushes additionally require `allowProduction: true` on the tool call. `worker.tool` only in MVP — `worker.automation` is private alpha and will mirror the same internal helper once GA. |
| `workers/ingest-client-notion` | **Building now** | Pulls feature-request pages from one or more *client* Notion workspaces into a managed Notion DB `Client Feature Requests`. Per-client internal integration tokens. Backfill + delta syncs, composite key `${clientId}:${pageId}`. Page bodies rendered to markdown (depth 2, 50 KB cap). |
| `workers/ingest-slack` | **Building now** | Pulls Slack threads from all public, non-shared channels in a single workspace into two managed Notion DBs: `Slack Channels` (one row per channel — name, topic, member count, internal creator) and `Slack Messages` (one row per top-level thread, with the full reply chain in the page body and a two-way relation back to its channel). Three syncs: `slackChannelsSync` (replace, 1h, also auto-joins channels), `slackBackfill` (replace, manual), `slackDelta` (incremental, 5m). Bot messages included; system events filtered. Single workspace (`SLACK_BOT_TOKEN`) in v1; composite key on messages reserves room for `${workspaceId}:` prefix. |
| `workers/ingest-loom` | **Building now** | Enriches Loom videos referenced from an existing Notion source DB (`c148c2e3aa554651bd9ca44b1de751d0`, `Video URL` property) into a managed Notion DB `Loom Videos`. One row per source page (`Source Page ID` = primary key) with title, thumbnail, duration, description, upload date, owner, view/comment counts, and transcript. Two syncs: `loomBackfill` (replace, manual), `loomDelta` (incremental, 5m). Enrichment uses three public Loom surfaces composed with graceful degradation — oEmbed + share-page OG/JSON-LD scrape (stable) + undocumented public GraphQL (kill switch `LOOM_ENABLE_GRAPHQL`). Private / deleted videos kept as marker rows (`Sync Status = Private/Unavailable`) rather than skipped. No write-back to the source DB. |
| `REQUIREMENTS.md`, `SCHEMA.md` | **Building now** | Living docs per `CLAUDE.md`. |

## Planned (next iterations, not built yet)

- `workers/agent-categorizer` — read from the ingest DBs, classify items (topic, customer, action-required), write to a shared `Review Queue` DB. Calls `workers/push-to-client` for approved rows.
- `workers/agent-summarizer` — produce digest pages from clusters of categorized items.
- Webhook-driven ingest (e.g., Fireflies "Transcription completed") to replace polling.
- Reverse sync from the client workspace (TBD).

## Constraints

- **Notion Workers platform only.** Each worker is its own deployable; one folder per worker (per `CLAUDE.md`).
- **No secrets in git.** All secrets via `ntn workers env`; `.env` is gitignored; each worker ships a committed `.env.example` (keys only, no values).
- **Treat synced data as untrusted.** Transcripts, message content, and agent tool inputs come from external systems. Never inject untrusted text into prompts or tool calls without sanitization.
- **Rate limits matter.** Each ingest worker must declare a `worker.pacer()` calibrated to the source API.
- **Client workspace push** is the most sensitive path. Default the `push-to-client` worker to a staging Notion workspace; only swap to production for an explicit, deliberate production demo.

## How we evaluate "done" for a worker

1. Types check (`npm run check`).
2. Tests pass (`npm test`).
3. `ntn workers sync trigger <key> --preview` produces the expected output.
4. Worker's `README.md` is up to date with: purpose, exposed syncs/tools, required secrets, agents that invoke it.
5. Schema or sync-mapping changes are reflected in `SCHEMA.md`.

## Open questions / decisions deferred

- Multi-tenant access to the **same** Fireflies meeting (two API keys with overlapping access) → v1 stores per-account rows keyed by `${accountId}:${transcriptId}`, accepting the duplication. Dedup can happen downstream in the categorizer if needed.
- Reverse sync semantics from client workspace → TBD.
- Whether agent-generated pages live in the same DB as ingest data or a separate `Review Queue` DB → separate (planned).
- `workers/push-to-client` automation trigger → deferred until `worker.automation` is GA; same internal helper will sit behind the automation when available.
- `workers/push-to-client` update flow for previously-pushed pages → TBD. MVP is push-once-read-only; correcting or re-pushing a page is not supported.
- Per-client source-schema drift detection in `workers/ingest-client-notion` (alert when a client's Feature Requests DB lacks a canonical property) → deferred. v1 degrades silently with typed fallbacks; a future preflight could call `databases.retrieve` once per backfill and warn on missing canonical properties.
