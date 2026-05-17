# `push-to-client`

Notion Worker that pushes approved, categorized "Company Brain" items into the matching destination database in a client's external Notion workspace. Holds the most sensitive credential in the project (the per-client internal-integration tokens) per [CLAUDE.md](../../CLAUDE.md).

Destination databases follow the canonical **Transformation Hub** schema (https://www.notion.so/d931147211b445d9b62b0fd66cf5ff2b). Three doc types are supported — `Docs`, `Status Updates`, `Deliverables` — each writing into its own destination database in the client's workspace.

## What it exposes

| Capability | Type | Schedule | Purpose |
|---|---|---|---|
| `pushToClient` | tool | — | Creates a single page in a destination database for one of the three doc types, picked by the `docType` input. Idempotent on `brainId`. Refuses production pushes without an explicit `allowProduction: true` flag. The low-level push primitive — agents call this directly when they have a fully-assembled payload. |
| `dispatchDraft` | tool | — | Reads an AI Drafts row, routes it to one or both destinations based on its `Status`, and writes back `Status` + `Location`. The orchestrator above `pushToClient`. |
| `onDraftStatusChange` | webhook | — | Receives Notion-database-automation posts when an AI Drafts row's `Status` changes. Calls `dispatchDraft` per event. Production-mode pushes from the webhook always run with `allowProduction=false`; trigger production from a human-invoked `dispatchDraft` tool call instead. |

Per-doc-type destination contract documented in [SCHEMA.md](../../SCHEMA.md). Clients clone each destination DB from the Transformation Hub template and add a `Brain ID` (rich_text) property — our augmentation for idempotency. The Deliverables clone additionally needs an `Owner` (people) column we add for the DRI handoff; preflight throws if it's missing.

## Required env

Per-client config (all keyed by the same uppercase `<ID>` suffix; the parsed client id is its lowercase form):

| Var | Required? | Default | Description |
|---|---|---|---|
| `CLIENT_TOKEN_<ID>` | yes | — | The client's Notion internal-integration token (`ntn_...`). Grant: Read / Update / Insert content + "Read user information including email addresses" (for Presenter / Owner resolution). |
| `CLIENT_DOCS_DB_<ID>` | yes | — | Destination database id for `docType=Docs`. |
| `CLIENT_STATUS_UPDATES_DB_<ID>` | yes | — | Destination database id for `docType=StatusUpdate`. |
| `CLIENT_DELIVERABLES_DB_<ID>` | yes | — | Destination database id for `docType=Deliverable`. |
| `CLIENT_MODE_<ID>` | no | `staging` | `staging` or `production`. A production-mode push additionally requires `allowProduction: true` on the tool call. |
| `COMPANY_PAGE_<ID>` | yes for `dispatchDraft` | — | Page id (with or without dashes) of the client's row in our workspace's Companies DB. The dispatcher reads the draft's `Company` relation and looks it up here to pick the right Client OS destination. |
| `CLIENT_DISPLAY_NAME_<ID>` | no | `<id>` | Friendly name used in the AI Drafts `Location` markdown link text (e.g., "Aduro Advisors"). |

Reserved `notionstate` client (home workspace, used by the dispatcher for "Send to Notion State OS"):

| Var | Required? | Default | Description |
|---|---|---|---|
| `CLIENT_TOKEN_NOTIONSTATE` | yes for `dispatchDraft` | — | Home-workspace integration token. Must have Read / Update / Insert access to: the AI Drafts DB, the Artifact Categories registry, the Companies DB, and the three NS OS destination DBs. |
| `CLIENT_DOCS_DB_NOTIONSTATE` | yes for `dispatchDraft` | — | NS OS Docs destination database id. |
| `CLIENT_STATUS_UPDATES_DB_NOTIONSTATE` | yes for `dispatchDraft` | — | NS OS Status Updates destination database id. |
| `CLIENT_DELIVERABLES_DB_NOTIONSTATE` | yes for `dispatchDraft` | — | NS OS Deliverables destination database id. |
| `CLIENT_MODE_NOTIONSTATE` | no | `staging` | Same semantics as a client; NS OS is treated as a peer. |
| `NS_OS_DISPLAY_NAME` | no | `Notion State OS` | Friendly name used in the AI Drafts `Location` markdown link text. |

Worker-level config for the dispatcher:

| Var | Required? | Default | Description |
|---|---|---|---|
| `DRAFTS_REGISTRY_ARTIFACT_CATEGORIES_DS` | yes for `dispatchDraft` | — | Data source id of the Artifact Categories registry inside our workspace. Today: `6d03178d-90aa-47cf-912a-459e1ff7983d`. |

All three destination DB ids are required per client. Partial config throws at module-init. The dispatcher's deps are constructed lazily — installations that haven't onboarded `notionstate` yet can still use the `pushToClient` tool.

See `.env.example`.

## Multi-client config

Adding a client is a config change, not a code change:

```bash
ntn workers env set CLIENT_TOKEN_BETA=ntn_...
ntn workers env set CLIENT_DOCS_DB_BETA=<docs-db-id>
ntn workers env set CLIENT_STATUS_UPDATES_DB_BETA=<status-db-id>
ntn workers env set CLIENT_DELIVERABLES_DB_BETA=<deliverables-db-id>
ntn workers env set CLIENT_MODE_BETA=staging
ntn workers deploy   # redeploy so the new pacer + ClientApi are wired
```

Each client gets its own pacer (3 req/s, calibrated to Notion's per-integration limit), so concurrent pushes to different workspaces do not share a budget.

## Local development

```bash
cd workers/push-to-client
npm install
cp .env.example .env
# edit .env with the four required env vars (token + 3 destination DB ids)

npm run check          # TypeScript
npm test               # vitest unit suite
npm run test:watch     # iterative
```

## Deploy

```bash
ntn workers deploy --name push-to-client     # first time
ntn workers env set CLIENT_TOKEN_<ID>=ntn_...
ntn workers env set CLIENT_DOCS_DB_<ID>=<docs-db-id>
ntn workers env set CLIENT_STATUS_UPDATES_DB_<ID>=<status-db-id>
ntn workers env set CLIENT_DELIVERABLES_DB_<ID>=<deliverables-db-id>
ntn workers env set CLIENT_MODE_<ID>=staging
```

After the first deploy you can re-deploy with just `ntn workers deploy`.

## Verifying

```bash
# Smoke create a Doc against the configured staging client
ntn workers exec pushToClient --local -d '{
  "clientId": "<id>",
  "docType": "Docs",
  "brainId": "verify-doc-1",
  "title": "[Verify] push-to-client Doc",
  "type": "Guide",
  "status": "Drafting",
  "bodyMarkdown": "# Verify\n\n- one\n- two"
}'

# Smoke create a Status Update
ntn workers exec pushToClient --local -d '{
  "clientId": "<id>",
  "docType": "StatusUpdate",
  "brainId": "verify-su-1",
  "title": "[Verify] Status Update @Next Monday",
  "date": "2026-05-18",
  "summary": "Hello world.",
  "presenterEmail": "you@notionstate.com"
}'

# Smoke create a Deliverable
ntn workers exec pushToClient --local -d '{
  "clientId": "<id>",
  "docType": "Deliverable",
  "brainId": "verify-deliv-1",
  "title": "[Verify] Aduro Home",
  "status": "Planning",
  "timelineStart": "2026-05-15",
  "timelineEnd": "2026-06-30"
}'

# Idempotency — same brainId + docType returns already_pushed without creating a new page
ntn workers exec pushToClient --local -d '{ ... same brainId, same docType ... }'

# Watch the audit log
ntn workers runs list --plain | head
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

See `test.sh` for the full smoke script.

## Source layout

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: per-client pacers + `ClientApi` registry, `worker.tool("pushToClient", ...)`. Validates per-docType required fields in `execute` before any network call. |
| `src/clients.ts` | Enumerate clients from env (`CLIENT_TOKEN_<ID>` + the three `CLIENT_*_DB_<ID>` + `CLIENT_MODE_<ID>`). Pure / tested. |
| `src/doc-types.ts` | Single source of truth for the three canonical Transformation Hub schemas (`Docs`, `StatusUpdate`, `Deliverable`): title property name, required + optional canonical props with types, required payload fields. |
| `src/notion-client.ts` | `createClientApi(cfg, pacer, loadUsersByEmail)` — bundles SDK client + pacer + config + the lazy email→user-id resolver. |
| `src/mode-gate.ts` | `assertModeAllowsPush` staging/production interlock. Pure / tested. |
| `src/markdown.ts` | Markdown subset → `BlockObjectRequest[]`. Pure / tested. |
| `src/properties.ts` | Typed property builders (title / richText / select / status / date / dateRange / checkbox / people / url) + per-docType `buildPropertiesFor` orchestrator. |
| `src/preflight.ts` | Per-`(clientId, docType, destDbId)` schema verification. Resolves database id → data source id, checks required canonical properties + `Brain ID`, captures `Status` and `Type` options. Cached promise per key. |
| `src/people.ts` | Email→Notion user id resolver. Paginated `users.list` indexed once per client lifetime. |
| `src/dedup.ts` | `findExistingByBrainId` — destination-side idempotency lookup (queries `Brain ID` rich_text). |
| `src/push.ts` | Orchestrator: mode gate → log → preflight → option validation → dedup → Presenter resolution (StatusUpdate only) → markdown → `pages.create` (+ chunked append). |
| `src/api-errors.ts` | Shared Notion error translation (401 → `IntegrationRevoked`, 429 → `RateLimited`, …). |
| `src/errors.ts` | `PushToClientError` base + typed subclasses (incl. `MissingRequiredField`, `DestinationSchemaMismatch` with `unknownStatus` / `unknownType` details). |
| `src/fixtures/` | Shared test helpers (e.g., `makeApiError` for `APIResponseError`). |

## AI Drafts dispatcher

The `dispatchDraft` tool and `onDraftStatusChange` webhook implement the [AI Drafts Trigger and Return spec](https://www.notion.so/notionstate/AI-Drafts-Trigger-and-Return-362d3984d5b880cdb14ef2e2418685bf). Flow:

1. A consultant flips an AI Drafts row's `Status` to one of `Send to Both`, `Send to Client OS`, or `Send to Notion State OS`.
2. A Notion database automation on the AI Drafts DB posts to this worker's `onDraftStatusChange` webhook with at least `{ "pageId": "<draft page id>" }`.
3. The webhook invokes `dispatchDraft`, which:
   - Reads the draft (Status, Name, Source Excerpt, Artifact Category relation, Company relation, body blocks).
   - Resolves `docType` from `Artifact Category` (rejects Feature Requests).
   - Resolves `clientId` from `Company` via `COMPANY_PAGE_<ID>` (only for Client OS routes).
   - Fills sensible per-docType defaults for fields the Drafts DB doesn't carry (Docs Type=Guide / Status=Drafting; Status Update Date=today / Summary=Source Excerpt; Deliverable Status=Not Started / Timeline=today).
   - Calls `pushToClient` once or twice (one per destination side). Brain ID dedup makes retries safe.
   - Writes back `Status` + a Markdown `Location` (one line per destination, prefixed `Client OS:` / `NS OS:`).
4. On any per-side failure, `Status` is left in the originating `Send to …`, the partial `Location` is written, and `DraftDispatchFailure` is surfaced.

### Wiring the Notion-side automation

After `ntn workers deploy`:

```bash
ntn workers webhooks list   # prints the onDraftStatusChange URL
```

In Notion, open the AI Drafts database → `...` → Automations → New automation:
- **Trigger:** `Status` is set to `Send to Both` OR `Send to Client OS` OR `Send to Notion State OS`.
- **Action:** Send to webhook → paste the URL above. Body:

  ```json
  { "pageId": "{{trigger.id}}" }
  ```

The unique URL is the shared secret — keep it out of public docs. The webhook also accepts `{ "page_id": "..." }` or `{ "data": { "id": "..." } }` for flexibility.

### Drafts DB schema we contract against (read-only)

This worker does not own the AI Drafts DB. It reads these property names verbatim — schema changes there need to be reflected here:

| Property | Type | Use |
|---|---|---|
| `Name` | title | → destination page title |
| `Status` | status | trigger + writeback target |
| `Location` | text | writeback target |
| `Artifact Category` | relation → Artifact Categories registry | → `docType` |
| `Company` | relation → Companies | → `clientId` via `COMPANY_PAGE_<ID>` |
| `Source Excerpt` | text | → Status Update `summary` default |

The page body is rendered to a markdown subset (paragraphs / H1-H3 / lists / fenced code / quotes / divider; inline bold/italic/code/link). Toggles, callouts, tables, embeds degrade per the subset; see `src/body-renderer.ts`.

## Consumed by

- Notion AI Drafts database automation → `onDraftStatusChange` webhook → `dispatchDraft`.
- (planned) `workers/agent-categorizer` — drafts get categorized and assigned a docType / Company before reaching the consultant for the Status flip.
- Humans, via `ntn workers exec pushToClient ...` or `ntn workers exec dispatchDraft --local -d '...'`, for ad-hoc pushes during demos / debugging.

## Known limitations

- **Relations not set.** Docs `Project` and Status Updates `Event` are relations to other databases in the client's workspace. We don't know the destination-side page ids, so we leave those properties empty — the client links them manually post-push. Documented in SCHEMA.md.
- **Presenter is best-effort.** On Status Updates, `presenterEmail` is resolved against the destination workspace's user list via `users.list`. If no match, the push succeeds with `Presenter` empty and a warning is returned. The client can add the user to the workspace and re-push, or set the property manually.
- **Owner is best-effort.** On Deliverables, the `Owner` column must exist on the destination (preflight fails closed) but the data is best-effort: the dispatcher reads the first `DRI` from the draft, resolves it to an email via the home workspace's `users.retrieve`, then re-resolves that email per destination workspace. Cross-workspace (e.g., a home-workspace DRI on a client push) typically lands an empty `Owner` array + warning — the client adds the user to the workspace and re-pushes to populate.
- **Push-once, read-only after.** A second push with the same `(brainId, docType)` returns `already_pushed` without writing. There is no update flow in MVP — correcting a pushed page requires the client to delete and re-trigger from the source.
- **Markdown subset only.** Tables, images, inline HTML, nested lists, task lists, footnotes are not supported. The translator emits warnings; unsupported lines are rendered as plain paragraphs where possible.
- **One destination DB per type.** Each destination database must contain exactly one data source. Multi-source destinations are rejected at preflight.
- **No retroactive dedup.** Pre-existing destination rows with the same `Brain ID` (e.g., from manual entries) are not de-duplicated.
- **No attachments.** File uploads / images / external embeds are not in scope.
- **Dispatcher defaults are best-effort.** Per-docType required destination fields (e.g., Docs `Type`, Deliverable `Timeline`) the Drafts DB doesn't carry are populated with sensible defaults (Guide / Drafting / Not Started / today). The destination consultant edits as needed.
- **Dispatcher partial failures leave Status untouched.** "Send to Both" with one side failing returns `partial_failure` (the structured error name is `DraftDispatchFailure`) and the operator must re-trigger after fixing the cause. `Brain ID` dedup keeps the retry safe.
- **Dispatcher relations are not propagated.** Docs `Project` / Status Updates `Event` stay empty in the destination after a dispatched draft — the consultant links them manually.

## Client onboarding checklist

A client follows these once to come online:

1. **Duplicate the three Transformation Hub destination databases** into their workspace from the canonical schema reference (https://www.notion.so/d931147211b445d9b62b0fd66cf5ff2b). One for each of `Docs`, `Status Updates`, `Deliverables`.
2. **Add a `Brain ID` rich_text property** to each of the three databases. (Our idempotency key — the rest of the schema is canonical.)
3. Go to Notion → Settings → Integrations → **Develop your own integrations** → "New internal integration" (or visit https://www.notion.so/profile/integrations/internal). Name it e.g. `Company Brain – <client>`; pick their workspace; grant **Read / Update / Insert content** and **Read user information including email addresses** capabilities. Copy the `ntn_...` token.
4. For each of the three databases, open it → `...` menu → **Connections** → enable the integration.
5. Send us (a) the integration token and (b) the database URL for each of the three destination DBs. We set `CLIENT_TOKEN_<ID>`, `CLIENT_DOCS_DB_<ID>`, `CLIENT_STATUS_UPDATES_DB_<ID>`, `CLIENT_DELIVERABLES_DB_<ID>`, and `CLIENT_MODE_<ID>=staging`, redeploy, and confirm with `--local` smoke runs for each docType.
6. When ready for the real workspace, we coordinate the swap to `CLIENT_MODE_<ID>=production` and start requiring `allowProduction: true` on each push.
