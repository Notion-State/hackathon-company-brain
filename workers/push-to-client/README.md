# `push-to-client`

Notion Worker that pushes approved, categorized "Company Brain" items into a client's external Notion workspace. Holds the most sensitive credential in the project (the per-client internal-integration tokens) per [CLAUDE.md](../../CLAUDE.md).

## What it exposes

| Capability | Type | Schedule | Purpose |
|---|---|---|---|
| `pushToClient` | tool | — | Creates a single page in a client's destination "Company Brain Inbox" database from an inline payload. Idempotent on `payload.brainId`. Refuses production pushes without an explicit `allowProduction: true` flag. |

The contract for the destination database is documented in [SCHEMA.md](../../SCHEMA.md) under **Company Brain Inbox**. Clients clone that schema into their own workspace.

## Required env

Per-client trio (all three keyed by the same `<ID>` suffix). The suffix is uppercase in the env-var name; the parsed client id is its lowercase form.

| Var | Required? | Default | Description |
|---|---|---|---|
| `CLIENT_TOKEN_<ID>` | yes | — | The client's Notion internal-integration token (`ntn_...`). Create at <https://www.notion.so/profile/integrations/internal>. Grant capabilities: Read / Update / Insert content. |
| `CLIENT_DEST_DB_<ID>` | yes | — | The destination database id (the "Company Brain Inbox" the client cloned). The integration must be shared with this DB via the database's `...` → Connections menu. |
| `CLIENT_MODE_<ID>` | no | `staging` | `staging` or `production`. A production-mode push additionally requires `allowProduction: true` on the tool call. |

See `.env.example`.

## Multi-client config

The worker is wired for one client in MVP but designed so adding more is a config change, not a code change. To add a client:

```bash
ntn workers env set CLIENT_TOKEN_BETA=ntn_...
ntn workers env set CLIENT_DEST_DB_BETA=<database-id>
ntn workers env set CLIENT_MODE_BETA=staging
ntn workers deploy   # redeploy so the new pacer + ClientApi are wired
```

Each client gets its own pacer (3 req/s, calibrated to Notion's per-integration limit), so concurrent pushes to different workspaces do not share a budget.

## Local development

```bash
cd workers/push-to-client
npm install
cp .env.example .env
# edit .env with CLIENT_TOKEN_<ID>, CLIENT_DEST_DB_<ID>, CLIENT_MODE_<ID>

npm run check          # TypeScript
npm test               # vitest unit suite
npm run test:watch     # iterative
```

## Deploy

```bash
ntn workers deploy --name push-to-client     # first time
ntn workers env set CLIENT_TOKEN_<ID>=ntn_...
ntn workers env set CLIENT_DEST_DB_<ID>=<database-id>
ntn workers env set CLIENT_MODE_<ID>=staging
```

After the first deploy you can re-deploy with just `ntn workers deploy`.

## Verifying

```bash
# Smoke create against the configured staging client
ntn workers exec pushToClient --local -d '{
  "clientId": "<id>",
  "payload": {
    "brainId": "verify-1",
    "title": "[Verify] push-to-client",
    "source": "Fireflies",
    "category": "summary",
    "originalDate": "2026-05-16T18:00:00.000Z",
    "originUrl": "https://example.com/origin",
    "bodyMarkdown": "# Verify\n\n- one\n- two"
  }
}'

# Idempotency — same brainId returns already_pushed without creating a new page
ntn workers exec pushToClient --local -d '{ ... same brainId ... }'

# Production gate — must throw ProductionPushNotAuthorized
ntn workers exec pushToClient --local -d '{ "clientId": "<prod-id>", "payload": { ... } }'

# Production gate satisfied
ntn workers exec pushToClient --local -d '{ "clientId": "<prod-id>", "payload": { ... }, "allowProduction": true }'

# Watch the audit log
ntn workers runs list --plain | head
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

See `test.sh` for the full smoke script.

## Source layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: per-client pacers + `ClientApi` registry, `worker.tool("pushToClient", ...)`. |
| `src/clients.ts` | Enumerate clients from env (`CLIENT_TOKEN_<ID>` / `CLIENT_DEST_DB_<ID>` / `CLIENT_MODE_<ID>`). Pure / tested. |
| `src/notion-client.ts` | `createClientApi(cfg, pacer)` — bundles SDK client + pacer + config. |
| `src/mode-gate.ts` | `assertModeAllowsPush` staging/production interlock. Pure / tested. |
| `src/markdown.ts` | Markdown subset → `BlockObjectRequest[]`. Pure / tested. |
| `src/properties.ts` | Typed property builders + `buildProperties` orchestrator. Pure / tested. |
| `src/preflight.ts` | `verifyDestSchema` + `PreflightCache`. Resolves database id → data source id, checks required properties, captures `Category` options. Tested. |
| `src/dedup.ts` | `findExistingByBrainId` — destination-side idempotency lookup. Tested. |
| `src/push.ts` | Orchestrator: mode gate → preflight → category check → dedup → markdown → `pages.create` (+ chunked append). Tested. |
| `src/errors.ts` | `PushToClientError` base + typed subclasses with `toJSON()`. Tested. |
| `src/fixtures/` | Shared test helpers (e.g., `makeApiError` for `APIResponseError`). |

## Consumed by

- (planned) `workers/agent-categorizer` — reads the Review Queue, calls `pushToClient` for approved rows.
- Humans, via `ntn workers exec pushToClient ...`, for ad-hoc pushes during demos / debugging.

## Known limitations

- **Push-once, read-only after.** A second push with the same `brainId` returns `already_pushed` without writing. There is no update flow in MVP — correcting a pushed page requires the client to delete and re-trigger from the source. See REQUIREMENTS.md "Open questions".
- **Markdown subset only.** Tables, images, inline HTML, nested lists, task lists, footnotes are not supported. The translator emits warnings; unsupported lines are rendered as plain paragraphs where possible.
- **One destination DB per client.** The destination database must contain exactly one data source. Multi-source destinations are rejected at preflight.
- **No retroactive dedup.** If pre-existing duplicates exist in the destination (e.g., from manual entries or before this worker was deployed), the dedup query warns but does not de-duplicate them.
- **Flat schema.** The destination contract does not include relations; if a client wants to relate Inbox entries to other databases in their workspace, they do it on their side.
- **No attachments.** File uploads / images / external embeds are not in scope.

## Client onboarding checklist

A client follows these once to come online:

1. **Duplicate our published "Company Brain Inbox" template** into their Notion workspace. (See [SCHEMA.md](../../SCHEMA.md) for the contract; the property names + types must match exactly.)
2. Go to Notion → Settings → Integrations → **Develop your own integrations** → "New internal integration" (or visit <https://www.notion.so/profile/integrations/internal>). Name it e.g. `Company Brain – <client>`; pick their workspace; grant **Read / Update / Insert content** capabilities. Copy the `ntn_...` token.
3. Open the destination database in their workspace → `...` menu → **Connections** → search for the integration → enable.
4. Send us (a) the integration token and (b) the destination database URL. We set `CLIENT_TOKEN_<ID>`, `CLIENT_DEST_DB_<ID>`, and `CLIENT_MODE_<ID>=staging`, redeploy, and confirm with a `--local` smoke run.
5. When ready for the real workspace, we coordinate the swap to `CLIENT_MODE_<ID>=production` and start requiring `allowProduction: true` on each push.
