# Schema

Notion database schemas, page property definitions, and source-to-property sync mappings. Every managed database touched by a worker is documented here.

## Databases

### `Meeting Transcripts` (managed by `workers/ingest-fireflies`)

Holds one row per (Fireflies account, transcript). Primary key is composite `Record ID = ${accountId}:${transcriptId}` so multi-account ingest does not race on shared meetings.

All properties are emitted on every change record (the SDK's strict mapped type requires it); the "Source nullable?" column indicates whether the upstream Fireflies value may be missing, in which case the noted fallback is used.

| Property | Type | Source nullable? | Source / fallback |
|---|---|---|---|
| `Title` | title | yes | `transcript.title`. Fallback: `"Untitled meeting"`. |
| `Record ID` | rich_text | no | **Primary key.** `${accountId}:${transcriptId}`. |
| `Transcript ID` | rich_text | no | Bare Fireflies transcript id. Groups the same meeting across accounts. |
| `Account` | select | no | Fireflies account id (the `<ID>` half of `FIREFLIES_API_KEY_<ID>`, or `"default"` for the unsuffixed key). Options declared at worker init from the configured accounts. |
| `Meeting Date` | date (datetime) | yes | `transcript.date`. Fallback: sync run timestamp (Fireflies transcripts should always carry a date in practice). |
| `Duration (min)` | number | yes | `Math.round(transcript.duration)`. Fireflies returns `duration` as **float minutes** (verified empirically — public docs say seconds but the API disagrees). Fallback: `0`. |
| `Host` | email | yes | `transcript.host_email` (regex-validated). Fallback: empty string. |
| `Attendees` | rich_text | yes | `meeting_attendees[].displayName` joined `", "`. Fallback: empty string. |
| `Speakers` | rich_text | yes | `speakers[].name` deduped, joined `", "`. Fallback: empty string. (Stored as text rather than multi_select so the schema doesn't need every possible speaker pre-declared at module-init.) |
| `Transcript URL` | url | yes | Fireflies meeting permalink. Fallback: empty string. |
| `Source` | select | no | Hardcoded `"Fireflies"`. Future-proofs for `Slack`/`Loom` once other ingest workers land. |
| `Synced At` | date (datetime) | no | Wall-clock timestamp at sync run. |

#### Page body (`pageContentMarkdown`)

```
# {Title}

**Date:** {Meeting Date}  |  **Duration:** {Duration} min  |  **Host:** {Host}
**Attendees:** {Attendees}

## Summary
{summary.overview}

## Action Items
- {summary.action_items[0]}
- ...

## Keywords
{summary.keywords joined ", "}

## Transcript

**{speaker}:** {text}

**{speaker}:** {text}
...
```

Markdown → Notion blocks is handled by the runtime. Empty sections render as a placeholder line (e.g., `_No action items captured._`) so the page structure stays predictable.

#### Sync sources

| Sync key | Mode | Schedule | Purpose |
|---|---|---|---|
| `firefliesBackfill` | `replace` | `manual` | Full-window (`FIREFLIES_BACKFILL_DAYS`, default 30) re-fetch per account. Replace mode mark-and-sweeps deletions. Trigger after deploy and when stale records need cleanup. |
| `firefliesDelta` | `incremental` | `5m` | Per-account cursor on meeting `date`, advanced with a **1-hour consistency buffer** to catch late-arriving transcripts (Fireflies can take 30–60 min to finalize long meetings). |

### `Client Feature Requests` (managed by `workers/ingest-client-notion`)

Holds one row per `(client, source page)` pulled from each configured client's Notion workspace. Primary key is composite `Record ID = ${clientId}:${pageId}` so two clients can mirror unrelated trackers without colliding.

Every property is emitted on every change record (the SDK's strict mapped type requires it); missing source values get the typed fallback noted below.

#### Source-side canonical schema (what each client's Feature Requests DB must contain)

Mirrored from the project schema reference at `https://www.notion.so/d931147211b445d9b62b0fd66cf5ff2b` filtered to `Source Database = Feature Requests`. Required properties must exist by name on each client's database; missing properties don't crash the sync but produce sparse rows downstream.

| Property name (source) | Type | Required | Notes |
|---|---|---|---|
| (any title-typed property) | title | yes | The name doesn't matter — we find the title by `type === "title"` (Notion guarantees exactly one). Canonical name is `Name`. |
| `ID` | unique_id | no | Auto-generated, e.g. `FR-42`. Serialized as `${prefix}-${number}` (or `#${number}` if no prefix). |
| `Description` | rich_text | no | Free-text request scope. |
| `Status` | status | yes | Groups: `To-do` {Triage, Planned}, `In progress` {Active, POC Review}, `Complete` {Done}. |
| `Submitter` | people | no | Person(s) who submitted the request. Serialized to `"Name <email>, …"`; email omitted when unavailable. |
| `Priority` | select | no | Critical, High, Medium, Low. |
| `Complexity` | select | no | High, Medium, Low. |
| `Effort` | select | no | High, Medium, Low. |
| `Projection` | select | no | Company, Leadership, Department, Team, Individual. |
| `Type` | select | no | Client-specific (e.g. `"Support & Maintenance"`). |
| `Team` | rich_text | no | Free-text team name. |
| `Dependencies` | rich_text | no | Free-text dependencies. |
| `Assigned Owner` | select | no | Client-specific. |
| `POC` | people | no | Serialized like `Submitter`. |
| `Proposed Owner` | formula | no | Read-only string formula result. |
| `Support Owner` | people (single) | no | Serialized like `Submitter`. |
| `Technical Lead` | people (single) | no | Serialized like `Submitter`. |

#### Internal property table

| Property | Type | Source / fallback |
|---|---|---|
| `Title` | title | Source title (any `type === "title"` property). Fallback: `"Untitled feature request"`. |
| `Record ID` | rich_text | **Primary key.** `${clientId}:${pageId}`. |
| `Client` | select | `clientId`. Options pre-declared at module init from discovered `CLIENT_NOTION_TOKEN_*` env vars. Adding a new client requires a redeploy. |
| `Source` | select | Hardcoded `"Notion"`. Future-proofs alongside `"Fireflies"`. |
| `Source Page ID` | rich_text | Bare Notion page id. |
| `Source Unique ID` | rich_text | `${prefix}-${number}` (or `#${number}` if no prefix). Empty if source has no `ID`. |
| `Source URL` | url | `page.url`. |
| `Description` | rich_text | From source `Description` (concat of `rich_text.plain_text`). Empty if absent. |
| `Status` | status | From source `Status`. Groups mirror canonical. Fallback: `"Triage"` (keeps row in the "To-do" group). |
| `Priority` | select | Critical / High / Medium / Low. Empty if source value is null. |
| `Complexity` | select | High / Medium / Low. |
| `Effort` | select | High / Medium / Low. |
| `Projection` | select | Company / Leadership / Department / Team / Individual. |
| `Type` | rich_text | From source `Type` (a select). Stored as text since option sets vary per client and the SDK requires pre-declared select options. |
| `Team` | rich_text | From source `Team`. |
| `Dependencies` | rich_text | From source `Dependencies`. |
| `Assigned Owner` | rich_text | From source `Assigned Owner` (a select). Stored as text — same reason as `Type`. |
| `Submitter` | rich_text | Serialized people: `"Name <email>, …"` (email omitted when unavailable). Can't use `Schema.people` because source users don't exist in our internal workspace. |
| `POC` | rich_text | Serialized people. |
| `Support Owner` | rich_text | Serialized people (single, but defensive against multiples). |
| `Technical Lead` | rich_text | Serialized people. |
| `Proposed Owner` | rich_text | Formula result coerced to string. |
| `Source Created Time` | date (datetime) | `page.created_time`. |
| `Source Last Edited Time` | date (datetime) | `page.last_edited_time`. Drives the delta cursor. |
| `Synced At` | date (datetime) | Wall-clock at sync run. |

#### Page body (`pageContentMarkdown`)

```
# {Title}

**Client:** {clientId}  |  **Status:** {Status}  |  **Priority:** {Priority}
**Source:** {Notion URL}  |  **Last edited:** {last_edited_time}

## Description property
{Description, or "_No description property._"}

## Page content
{rendered blocks from the source page, capped at 50 KB; depth-2 recursion}

_…[truncated at 50KB; see source page]_   ← only if cap hit
```

Page-body rendering supports `paragraph`, `heading_1/2/3`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `code`, `quote`, `callout`, `divider`. Other types render as `_[unsupported block: <type>]_`. Children deeper than depth 2 render as `_[nested children truncated]_`. All user-supplied text is markdown-escaped before concatenation (synced data is untrusted).

#### Sync sources

| Sync key | Mode | Schedule | Purpose |
|---|---|---|---|
| `clientFeatureRequestsBackfill` | `replace` | `manual` | Full sweep of each client's data source. Iterates clients in a stable order, exhausting one client's pagination cursor before moving to the next. Replace-mode mark-and-sweep is the deletion mechanism (archived/in-trash pages on the client side disappear from our DB on the next backfill). Trigger after onboarding a client and weekly to reap deletes. |
| `clientFeatureRequestsDelta` | `incremental` | `5m` | Per-client `last_edited_time` cursor with a **60-second consistency buffer** (Notion writes are atomic, so 60s suffices for replica propagation + clock skew). Does not pick up deletions — only the backfill catches them. First-run cursor is seeded `CLIENT_NOTION_BACKFILL_DAYS` (default 30) in the past. |

#### Client onboarding

See `workers/ingest-client-notion/README.md` for the five-step onboarding runbook (create internal integration → share DB → conform schema → send token+dbId → operator wires `ntn workers env set`).

### `Company Brain Inbox` (client-managed; **contract**, not a managed database)

The destination database in a client's Notion workspace. **We do not manage this database** — the client clones it from our published contract into their own workspace and shares it with the internal integration we configure in `workers/push-to-client`. The `pushToClient` tool reads the schema via `databases.retrieve` (preflight) and writes one page per call via `pages.create` against the resolved data source.

Required properties must exist with the listed type or `pushToClient` throws `DestinationSchemaMismatch` before any write. Optional properties are written when present and silently skipped when absent.

| Property | Type | Required | Notes |
|---|---|---|---|
| `Title` | title | yes | From `payload.title`. The human reviewer is expected to have proofread it. |
| `Brain ID` | rich_text | yes | **Idempotency key.** The categorizer's Review Queue page id. `pushToClient` queries `Brain ID == payload.brainId` before every push; a hit returns `status: "already_pushed"` and no new page is created. Manual entries in the destination must not reuse this property — pre-existing duplicates are not deduped retroactively. |
| `Source` | select | yes | Options the client must declare: `Fireflies`, `Slack`, `Loom`, `Other`. |
| `Category` | select | yes | Options align with the categorizer taxonomy (TBD; canonical list will live in this section once the categorizer ships). Push-time validation: `pushToClient` reads `Category.select.options` at preflight and rejects unknown categories with `DestinationSchemaMismatch` carrying `validCategories`. |
| `Original Date` | date | no | ISO 8601 datetime of the source event. |
| `Origin URL` | url | no | Permalink to the source (Fireflies meeting, Slack permalink, Loom video). |
| `Pushed At` | date | yes | Set by `pushToClient` to the ISO timestamp at create. |

#### Page body

Constructed by `pushToClient` from `payload.bodyMarkdown` via a documented Markdown subset (paragraphs, `#`/`##`/`###` headings, `-`/`1.` lists, fenced code blocks ` ``` `, `>` quotes, `---` dividers, inline `**bold**` / `*italic*` / `` `code` `` / `[text](url)`). Unsupported syntax is dropped with a warning surfaced in the tool result. Body is bounded at 50 KB; per-block rich-text runs are split at Notion's 2000-character limit; the `pages.create` 100-child cap is handled with chunked `blocks.children.append`.

#### Sync sources

None. The Inbox is a write-only destination — `pushToClient` creates one page per tool invocation against a data source the client owns. No managed sync writes here.

#### Client onboarding

See `workers/push-to-client/README.md` for the five-step onboarding checklist the client follows to create the internal integration, clone the Inbox template, and grant access.

## Adding a new database

When you add a managed Notion database in a worker, append a section to this file with:
- the property table,
- the page-body shape (if any),
- the sync(s) that write to it.

Schema or mapping changes require an update here before the worker is "done."
