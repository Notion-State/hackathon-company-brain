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
| `REQUIREMENTS.md`, `SCHEMA.md` | **Building now** | Living docs per `CLAUDE.md`. |

## Planned (next iterations, not built yet)

- `workers/ingest-slack` — sync canonical Slack channels into a `Slack Messages` DB.
- `workers/ingest-loom` — sync Loom video metadata + transcripts.
- `workers/agent-categorizer` — read from the ingest DBs, classify items (topic, customer, action-required), write to a shared `Review Queue` DB.
- `workers/agent-summarizer` — produce digest pages from clusters of categorized items.
- `workers/push-to-client` — push approved Review Queue items into the client's Notion workspace. Holds the most sensitive integration token in the project; default target = staging.
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
