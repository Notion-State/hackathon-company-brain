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

## Adding a new database

When you add a managed Notion database in a worker, append a section to this file with:
- the property table,
- the page-body shape (if any),
- the sync(s) that write to it.

Schema or mapping changes require an update here before the worker is "done."
