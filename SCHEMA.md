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

Mirrored from the project schema reference at `https://www.notion.so/<transformation-hub-db-id>` filtered to `Source Database = Feature Requests`. Required properties must exist by name on each client's database; missing properties don't crash the sync but produce sparse rows downstream.

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

### Transformation Hub destinations (client-managed; **contracts**, not managed databases)

`workers/push-to-client` writes into three destination databases per client, each conforming to the canonical **Transformation Hub** schema (https://www.notion.so/<transformation-hub-db-id>). **We do not manage these databases** — the client clones each from the canonical template into their own workspace and shares it with the integration we configure on the worker.

Every destination database has a single augmentation we publish on top of the canonical schema:

- `Brain ID` (rich_text) — **idempotency key.** `pushToClient` queries `Brain ID == payload.brainId` against the data source before every push; a hit returns `status: "already_pushed"` and no new page is created. Manual entries in the destination must not reuse this property — pre-existing duplicates are not deduped retroactively.

Preflight is per-`docType`: it resolves the configured database id to its single data source, verifies the required canonical properties + `Brain ID` are present with the right types, captures `Status` / `Type` options for push-time option validation, and records optional-property presence. `DestinationSchemaMismatch` is thrown before any write on missing/wrong-type props or on unknown option values supplied by the caller.

#### `Docs` (push target for `docType=Docs`)

| Property | Type | Required | Notes |
|---|---|---|---|
| `File Name` | title | yes | From `payload.title`. |
| `Brain ID` | rich_text | yes | Our augmentation. Idempotency key. |
| `Status` | status | yes | Options: `Drafting` / `In Review` / `Published` / `Archived`. Push-time validated against the destination's option set. |
| `Type` | select | yes | Options: `Contract`, `Brand`, `Framework`, `Requirements`, `Guide`, `Research`, `Planning`, `Analysis`. Push-time validated against the destination's option set. |
| `Project` | relation | n/a | **Not set by this tool** in MVP — relations to other client-owned databases require destination-side page ids the agent doesn't have. The client links these manually post-push. |

#### `Status Updates` (push target for `docType=StatusUpdate`)

| Property | Type | Required | Notes |
|---|---|---|---|
| `Title` | title | yes | From `payload.title` (e.g., `"Status Update @Next Monday"`). |
| `Brain ID` | rich_text | yes | Our augmentation. Idempotency key. |
| `Date` | date | yes | From `payload.date`. ISO 8601. |
| `Summary` | rich_text | yes | Free-text summary from `payload.summary`. |
| `Presenter` | people | no | **Best-effort.** When the destination has the property and `payload.presenterEmail` is set, we resolve the email against the destination workspace's users via `users.list` and write the matching user id. Unresolved → property left empty and a warning is returned. Skipped (with a warning) when the destination lacks the property. |
| `Addressed` | checkbox | no | From `payload.addressed`. Skipped when null or when the destination lacks the property. |
| `Event` | relation | n/a | **Not set by this tool** in MVP. Same reason as Docs `Project`. |

#### `Deliverables` (push target for `docType=Deliverable`)

| Property | Type | Required | Notes |
|---|---|---|---|
| `Title` | title | yes | From `payload.title` (e.g., `"Aduro Home"`). |
| `Brain ID` | rich_text | yes | Our augmentation. Idempotency key. |
| `Status` | status | yes | Options: `Not Started` / `Planning` / `In Progress` / `In Review` / `Ongoing` / `Postponed` / `Blocked` / `Done` / `Propose Delete`. Push-time validated against the destination's option set. |
| `Timeline` | date | yes | From `payload.timelineStart` (single date) or `(timelineStart, timelineEnd)` (date range). |
| `Owner` | people | yes (column) | **Best-effort data.** The column must exist on the destination — preflight throws `DestinationSchemaMismatch` if missing. When `payload.ownerEmail` is set, we resolve it against the destination workspace's users via `users.list` and write the matching user id. Unresolved (cross-workspace, no published email, etc.) or empty → property written as `{ people: [] }` and a warning is returned. The dispatcher fills `ownerEmail` from the draft's `DRI` people property. |

#### Page body

For all three doc types, the page body is constructed from `payload.bodyMarkdown` via a documented Markdown subset (paragraphs, `#`/`##`/`###` headings, `-`/`1.` lists, fenced code blocks ` ``` `, `>` quotes, `---` dividers, inline `**bold**` / `*italic*` / `` `code` `` / `[text](url)`). Unsupported syntax is dropped with a warning surfaced in the tool result. Body is bounded at 50 KB; per-block rich-text runs are split at Notion's 2000-character limit; the `pages.create` 100-child cap is handled with chunked `blocks.children.append`.

#### Sync sources

None. These are write-only destinations — `pushToClient` creates one page per tool invocation against the data source the client owns. No managed sync writes here.

#### Client onboarding

See `workers/push-to-client/README.md` for the onboarding checklist: clone the three destination databases from the canonical template, add `Brain ID` rich_text to each (and `Owner` people on the Deliverables clone — not in the upstream template), create an internal integration with Read/Update/Insert + Read-user-emails capabilities, share each destination DB with that integration, hand us the token + the three database urls, and we wire the env.

### `Slack Channels` (managed by `workers/ingest-slack`)

Holds one row per non-archived channel (public, private, shared, externally shared) in the configured Slack workspace. Primary key is the bare Slack channel id (e.g., `C01234ABC`), which is also the value the `Slack Messages` DB's `Channel` relation references.

Discovered each cycle of `slackChannelsSync` via `conversations.list(types: "public_channel,private_channel", exclude_archived: true)`. Only archived channels are filtered out. Replace mode mark-and-sweeps archived/removed channels between cycles.

| Property | Type | Source nullable? | Source / fallback |
|---|---|---|---|
| `Name` | title | no | `#${channel.name}`. Fallback: `"#unknown"`. |
| `Channel ID` | rich_text | no | **Primary key.** Bare Slack channel id (`C01234ABC`). |
| `Topic` | rich_text | yes | `channel.topic.value`, markdown-escaped, clipped at 2000 chars. Empty when unset. |
| `Purpose` | rich_text | yes | `channel.purpose.value`, markdown-escaped, clipped at 2000 chars. Empty when unset. |
| `Member Count` | number | yes | `channel.num_members`. Fallback: `0`. |
| `Is Member` | checkbox | no | `channel.is_member` after auto-join attempt. False on channels where join failed (e.g. `not_authorized`); the row is still written so the operator can see why ingest is stalled. |
| `Is Archived` | checkbox | no | `channel.is_archived`. Always `false` because `exclude_archived: true` filters them out at the list call; the property is kept for forward-compat. |
| `Is Private` | checkbox | no | `channel.is_private`. True for private channels. |
| `Is Shared` | checkbox | no | `channel.is_shared`. True for channels shared with another workspace via Slack Connect. |
| `Is Externally Shared` | checkbox | no | `channel.is_ext_shared`. True for externally shared (cross-org) channels. |
| `Member Emails` | rich_text | yes | Comma-separated emails of all channel members, resolved via `conversations.members` → `users.info`. Empty when the bot can't list members (e.g. `not_in_channel`). Clipped at 2000 chars. |
| `Channel Type` | select | no | Derived: `"Public"`, `"Private"`, or `"Slack Connect"` (ext-shared takes priority over private). |
| `Created` | date (datetime) | yes | `new Date(channel.created * 1000).toISOString()` (Slack returns epoch seconds). Fallback: sync run timestamp. |
| `Creator Email` | email | yes | `users.info(channel.creator).profile.email` via the shared identity cache. Empty for bot-created channels, when `users:read.email` is denied, or when the creator can't be resolved. |
| `Internal Creator` | people | yes | `Builder.people(creatorEmail)` when `creatorEmail` matches `INTERNAL_DOMAINS` (hardcoded `notionstate.com`). Empty otherwise. |
| `Slack URL` | url | no | `https://${team.domain}.slack.com/archives/${channelId}`. `team.domain` from a one-time `team.info` call at module init (cached). Falls back to `app.slack.com/archives/...` if `team.info` fails. |
| `Source` | select | no | Hardcoded `"Slack"`. |
| `Synced At` | date (datetime) | no | Wall-clock timestamp at sync run. |

#### Page body (`pageContentMarkdown`)

```
# {Name}

**Members:** {Member Count}  |  **Created:** {Created}  |  **Created by:** {Creator display name (@handle)}

**Topic:** {Topic, or "_No topic set._"}

**Purpose:** {Purpose, or "_No purpose set._"}

**Member Emails:** {comma-separated emails}   ← only when non-empty

[Open in Slack]({Slack URL})
```

#### Sync sources

| Sync key | Mode | Schedule | Purpose |
|---|---|---|---|
| `slackChannelsSync` | `replace` | `1h` | Discovers all non-archived channels (public, private, shared, externally shared), auto-joins via `conversations.join` where `is_member: false`, resolves member emails via `conversations.members` + identity cache, writes one row per channel. Replace-mode mark-and-sweep deletes channels archived/removed since the last cycle. |

### `Slack Messages` (managed by `workers/ingest-slack`)

Holds one row per top-level Slack thread (i.e., one row per parent message). Replies render into the page body — they do not get their own rows. Primary key is composite `Record ID = ${channelId}:${threadTs}`; Slack `ts` is microsecond-precise and globally unique within a tenant, but the channel prefix protects against any cross-channel collision and reserves room for a future `${workspaceId}:` prefix without re-keying.

Bot messages are included as first-class authors (rendered as `{botName} (bot)`). System events (`channel_join`, `pinned_item`, `channel_topic`, etc.) and tombstones (deleted parents) are filtered out by `src/system-events.ts` / `src/threads.ts`.

| Property | Type | Source nullable? | Source / fallback |
|---|---|---|---|
| `Title` | title | yes | First ~80 chars of parent message text (whitespace collapsed, ellipsized). Fallback: `"[Message in #${channel.name}]"`. |
| `Record ID` | rich_text | no | **Primary key.** `${channelId}:${threadTs}`. |
| `Channel` | relation → `slack-channels-v1` (two-way, back-ref `"Threads"`) | no | `[Builder.relation(channelId)]`. The referenced primary key equals the `Slack Channels` row's `Channel ID`. Notion auto-maintains a `Threads` property on the Channels row listing every thread in that channel — no emission from this sync required. |
| `Author` | rich_text | no | For humans: `"Real Name (@handle)"` via `users.info`. For bots: `"{botName \|\| username} (bot)"`. Fallback: `"(unknown)"`. |
| `Author Email` | email | yes | From `users.info` for humans; empty for bots. |
| `Internal Participants` | people | yes | All distinct emails seen in the thread (parent + replies) whose domain matches `INTERNAL_DOMAINS`. Passed to `Builder.people(...emails)`; Notion resolves to workspace users at sync time and silently drops non-matches. Mirrors fireflies' `Notion State Attendees` pattern. |
| `Thread Participants` | rich_text | yes | Comma-joined unique display names across parent + replies. Clipped at 2000 chars. |
| `Posted At` | date (datetime) | no | Parent `ts` → ISO datetime via `slackTsToIso`. |
| `Last Activity` | date (datetime) | no | `max(parent.ts, ...replies[].ts)` → ISO. **Drives the per-channel delta cursor.** |
| `Reply Count` | number | no | Count of non-system-event replies after filtering. |
| `Reaction Count` | number | no | Sum of `reactions[].count` across parent + all replies. Captured at write time; the delta refreshes this when it re-fetches a thread (because `conversations.replies` returns reactions), but threads with no new activity drift between backfills. |
| `Has Attachments` | checkbox | no | True if any message in the thread has non-empty `files[]` or any `attachments[]`. |
| `Permalink` | url | yes | From `chat.getPermalink(channel, message_ts=parentTs)`. Empty if the call returns `message_not_found` / `channel_not_found`. |
| `Source` | select | no | Hardcoded `"Slack"`. |
| `Synced At` | date (datetime) | no | Wall-clock timestamp at sync run. |

#### Page body (`pageContentMarkdown`)

```
# {Title}

**Channel:** #{channel.name}  |  **Posted:** {Posted At}  |  **Replies:** {Reply Count}
**Author:** {Author}
**Participants:** {Thread Participants, or "_None_"}

[View in Slack]({Permalink})   ← only when Permalink is present

## Thread

**{Author} — {ts ISO}**
{parent text, mrkdwn→commonmark converted}

- 📎 [{filename}]({slack file url})   ← only when attachments present

**{Reply Author} — {reply ts ISO}**
{reply text}

…
```

Slack mrkdwn → commonmark (`src/render-threads.ts:convertSlackMrkdwn`): user mentions resolve via the identity cache (`<@U…>` → `@handle`, unknown → `@user`); channel mentions become `#name` (or `#${channelId}` when no inline name); user-group mentions `<!subteam^…|name>` → `@name`; `<!here>`/`<!channel>`/`<!everyone>` → `@here`/`@channel`/`@everyone`; `<url|label>` → `[label](url)`; bare `<url>` → `url`; Slack HTML entities (`&lt;`/`&gt;`/`&amp;`) unescaped; `*bold*`/`_italic_`/`~strike~` → `**bold**`/`*italic*`/`~~strike~~` (with word-boundary heuristics so `file_name_here` isn't misread as italic).

The converted message text is **not** subsequently markdown-escaped — escaping would break the `[label](url)` links the conversion just produced. The structural template around it (header, metadata, permalink line) does use our own escaped strings, so structural integrity of the page is preserved even if a user injects markdown into their message. No XSS surface (Notion blocks aren't HTML).

#### Sync sources

| Sync key | Mode | Schedule | Purpose |
|---|---|---|---|
| `slackBackfill` | `replace` | `manual` | Re-discovers eligible channels (skipping non-member channels — `slackChannelsSync` owns the join). Per channel, paginates `conversations.history` from `now - SLACK_BACKFILL_DAYS`. For each top-level message with `reply_count > 0`, follows `conversations.replies` for the full thread. Replace mode mark-and-sweeps threads no longer present. Refreshes reactions on every thread. Trigger after deploy and whenever you want to clean up drift. |
| `slackDelta` | `incremental` | `5m` | Per-channel `lastActivityTs` cursor (Slack ts string) with a **60-second consistency buffer**. Re-discovers channels each cycle so newly-joined channels start picking up activity quickly. Refetches `conversations.replies` for any thread whose `latest_reply > cursor`. Does not pick up deletes (backfill's job). |

#### Known limitations

- **Backfill window is hard.** Threads with parent older than `SLACK_BACKFILL_DAYS` are not pulled, even if they have recent activity.
- **Edits to messages older than the delta window are not seen.** `conversations.history` filters by parent `ts`, not `edited.ts`. Backfill catches them.
- **No real-time deletes.** A deleted Slack message sticks in Notion until the next messages backfill.
- **Reactions drift between backfills** for threads with no new activity.
- **Auto-join is visible** ("X has joined the channel" — no API to suppress).
- **New-channel latency** ≤ 1h + 5min (next channels sync joins, next delta picks up).
- **Polling only**; Slack Events API deferred.

### `Loom Videos` (managed by `workers/ingest-loom`)

Holds one row per source-DB page that contains a Loom URL. Primary key is `Source Page ID = page.id` (the bare Notion page id from the source database `<loom-source-db-id>`). One source row → one target row; if the source row's `Video URL` value changes, the same target row updates in place. This preserves a 1:1 mapping with the source DB and means private/unavailable videos still get rows (with `Sync Status` set accordingly) so downstream agents can see what was attempted.

The Loom platform has **no general-purpose REST API**; the worker composes four independent public enrichment surfaces, each behind its own pacer, each catching failures:

- **oEmbed** (`https://www.loom.com/v1/oembed?url=…`) — documented, stable. Title, thumbnail, duration, author name.
- **Public share-page** OG/JSON-LD scrape — stable in practice (it's the same metadata every social-share preview uses). Description, upload date, JSON-LD VideoObject fields.
- **Public GraphQL** (`https://www.loom.com/graphql`) — undocumented, operation names drift. Composite query selects `getVideo` for owner / description / comment count and `fetchVideoTranscript` for a signed CloudFront URL pointing at the transcript JSON. Controlled by `LOOM_ENABLE_GRAPHQL` (kill switch).
- **Signed CloudFront transcript JSON** — fetched from the `source_url` GraphQL returned. ~5-minute Policy expiry; fetched immediately after GraphQL on a per-row basis.

Status precedence (`Sync Status` column):
- `Private` — oEmbed or share page returned 403.
- `Unavailable` — oEmbed or share page returned 404 (deleted/removed).
- `Enriched` — at least one of oEmbed / share page succeeded.
- `Failed` — both oEmbed and share page errored.

GraphQL failure never downgrades the row status — it's best-effort enrichment on top of Core metadata.

| Property | Type | Source nullable? | Source / fallback |
|---|---|---|---|
| `Title` | title | yes | oEmbed `title` → OG `og:title` → JSON-LD `name`. Fallback: `"Untitled Loom video"`. |
| `Source Page ID` | rich_text | no | **Primary key.** Bare Notion page id from the source DB (e.g., `a1b2c3d4-e5f6-…`). |
| `Source URL` | url | no | `page.url` — deep link to the source row. |
| `Video URL` | url | no | The `Video URL` property value on the source row (URL-typed; falls back to joined rich_text). |
| `Video ID` | rich_text | yes | Parsed from the Loom URL (`loom.com/share/<id>` or `loom.com/embed/<id>`, lowercased). Empty when URL is unparseable. |
| `Thumbnail URL` | url | yes | oEmbed `thumbnail_url` → JSON-LD `thumbnailUrl` → OG `og:image`. Stored as a URL (not a `file` property) because empty file-property values are undocumented and consumers can render the image themselves. |
| `Duration (sec)` | number | yes | oEmbed `duration` (seconds) → JSON-LD ISO 8601 `PT…` parsed → OG `og:video:duration`. Fallback: `0`. |
| `Owner Name` | rich_text | yes | GraphQL `owner.display_name` → oEmbed `author_name`. Empty when both absent or GraphQL disabled. |
| `Owner Email` | email | yes | GraphQL `owner.email`. Often empty even when GraphQL succeeds — Loom only surfaces email for owners who chose to expose it publicly. |
| `Upload Date` | date (datetime) | yes | JSON-LD `uploadDate` → GraphQL `createdAt`. Fallback: sync run timestamp (so the property is always populated). |
| `Description` | rich_text | yes | GraphQL `description` → OG `og:description` → JSON-LD `description`. Clipped at 2000 chars. GraphQL preserves newlines; the meta-tag values are condensed previews. Empty if all absent. |
| `Comment Count` | number | yes | GraphQL `commentCount`. Fallback: `0`. Drifts between backfills — see known limitations. |
| `Sync Status` | select | no | `Enriched` (green) / `Private` (orange) / `Unavailable` (red) / `Failed` (red). Computed from oEmbed + share-page statuses (GraphQL doesn't influence). |
| `Last Enriched At` | date (datetime) | no | Wall-clock at sync write. Equals `Synced At` in v1 but kept as a distinct property for future "skip-if-recently-enriched" cache logic. |
| `Source` | select | no | Hardcoded `"Loom"`. Future-proofs alongside the other ingest workers. |
| `Synced At` | date (datetime) | no | Wall-clock at sync run. |

Note: an "Embed URL" property is not stored because it's deterministic from `Video ID` — consumers can construct `https://www.loom.com/embed/${videoId}` themselves.

#### Page body (`pageContentMarkdown`)

```
# {Title}

> _Status: {Sync Status}. Some fields may be empty._   ← only when status ≠ Enriched

**Owner:** {Owner Name} <{Owner Email}>  |  **Uploaded:** {Upload Date}  |  **Duration:** {M:SS or H:MM:SS}
**Comments:** {Comment Count}
**Source page:** [{Source URL}]({Source URL})

[Watch on Loom]({Video URL})

## Description
{Description, or "_No description._"}

## Transcript

**[0:00] {speaker}:** {cue text}

**[0:12]** {cue text without speaker}

…
```

Transcript cues are rendered with `M:SS` (or `H:MM:SS`) timestamps. The transcript JSON Loom exposes carries no speaker label, so the speaker prefix is always omitted in v1. The transcript section falls back to `_Transcript not available._` when GraphQL didn't return a transcript URL (disabled, schema drift, or `transcription_status !== "success"`), when the signed-CloudFront fetch failed, or when the `phrases` array was empty.

#### Sync sources

| Sync key | Mode | Schedule | Purpose |
|---|---|---|---|
| `loomBackfill` | `replace` | `manual` | Full sweep of the source DB via `notion.dataSources.query` (single-source database; multi-source throws). Re-fetches every enrichment. Replace-mode mark-and-sweep removes target rows whose source pages were archived/deleted. Trigger after deploy and periodically (engagement metrics drift). |
| `loomDelta` | `incremental` | `5m` | Source DB filter `last_edited_time on_or_after {fromCursor}` sorted ascending. **60-second consistency buffer** (mirrors `ingest-client-notion`) — Notion writes are atomic so 60s comfortably covers cross-region propagation + clock skew. End-of-cycle promotes max `last_edited_time` seen to the new watermark, clamped to `now - 60s`. Does **not** refresh engagement metrics on unchanged source rows. |

#### Known limitations

- **GraphQL is best-effort and undocumented.** Operation names drift; `LOOM_ENABLE_GRAPHQL=false` is the kill switch.
- **View counts are not available.** Loom's public GraphQL surface exposes no Query field that reaches `VideoViewCounts`. The web UI loads view counts via an Apollo-cache reference that isn't reachable from the public schema; the column was removed in v1.
- **Engagement metrics drift between backfills** — `loomDelta` only re-enriches a row when the source DB row is edited.
- **Owner email is often empty.** Loom only surfaces the owner's email on public GraphQL responses for owners who chose to expose it; for most workspaces this is null.
- **Speaker labels are not surfaced.** Loom's transcript JSON has no speaker field; the rendered cues use `**[M:SS]** {text}` only.
- **Signed transcript URL has a ~5 min expiry.** The worker fetches the JSON immediately after GraphQL on a per-row basis; batching GraphQL calls and draining transcripts later would 403.
- **Password-protected videos are not supported** in v1.
- **No write-back** to the source DB.
- **Single source DB in v1.** The primary key uses bare `page.id` — a future second source DB would need a `${dbId}:` prefix to avoid collisions.

### `AI Drafts` (read-only contract — owned upstream; consumed by `workers/push-to-client` dispatcher)

This worker does **not** manage the AI Drafts database (`<ai-drafts-db-id>`). The `dispatchDraft` tool and `onDraftStatusChange` webhook read these property names verbatim and write back two of them; schema changes upstream need to be reflected here.

| Property | Type | Direction | Notes |
|---|---|---|---|
| `Name` | title | read | → destination page title (mapped to `File Name` for Docs, `Title` for the other two). Fallback when empty: `"Untitled draft"`. |
| `Status` | status | read + write | Trigger when set to `Send to Both` / `Send to Client OS` / `Send to Notion State OS`. Dispatcher writes back the resulting Complete value (`In Both` / `In Client Workspace` / `In Notion State OS`) on full success; leaves unchanged on partial failure or no-op. Already-Complete values (`In Both` / `In Client Workspace` / `In Notion State OS` / `Archive`) short-circuit to no-op. |
| `Location` | text | write | Markdown-formatted destination URLs, one per line: `Client OS: [<display name> – <docType>](<url>)` and/or `NS OS: [<display name> – <docType>](<url>)`. Written on dispatch (full or partial) — empty otherwise. |
| `Artifact Category` | relation → Artifact Categories registry (data source `<artifact-categories-ds-id>`) | read | → `docType`. Resolver title-matches registry rows: `Doc` → `Docs`, `Status Update` → `StatusUpdate`, `Deliverable` → `Deliverable`, `Feature Requests` → rejected as `UnpushableArtifactCategory`. Empty / unrecognized → `MissingDraftRelation`. |
| `Company` | relation → Companies | read | Required for Client OS-bound routes. First entry is looked up in the configured `COMPANY_PAGE_<ID>` → `clientId` mapping; missing mapping throws `MissingClientForCompany`. Multi-entry: uses the first with a warning. |
| `Source Excerpt` | text | read | Feeds the Status Update `summary` default (Status Update destinations require `Summary`; the Drafts DB doesn't carry it directly). Fallback when empty: draft `Name`. |
| `DRI` | people | read | Designated owner. Feeds the Deliverable `ownerEmail` payload: first DRI's Notion user id is resolved to an email via home `users.retrieve`, then re-resolved per destination workspace. Empty / unresolvable → empty `Owner` + warning (matches Presenter semantics). Multi-entry: uses the first with a `dispatch-draft: multiple DRI users` warning. |
| (page body blocks) | — | read | Rendered to markdown via the worker's body subset (paragraphs / H1-H3 / lists / fenced code / quotes / divider; inline bold/italic/code/link). Depth-2 recursion cap, 50 KB byte cap, unsupported block types render as `_[unsupported block: <type>]_`. |

#### Trigger → destination → resulting Status

| Trigger Status (in-progress group) | Destinations | Resulting Status (complete group) |
|---|---|---|
| `Send to Both` | Client OS **and** Notion State OS | `In Both` |
| `Send to Client OS` | Client OS only | `In Client Workspace` |
| `Send to Notion State OS` | Notion State OS only | `In Notion State OS` |

Failure mode (per the AI Drafts Trigger and Return spec): if any destination push fails, Status is left in the originating `Send to …` and the partial Location is written so the operator can see what landed. `Brain ID` dedup makes retries safe.

#### Defaults applied per docType

The Drafts DB does not carry the per-docType required fields the destination DBs need. The dispatcher fills them with sensible defaults on dispatch; the destination consultant edits as needed.

| docType | Field | Default |
|---|---|---|
| Docs | `type` | `"Guide"` |
| Docs | `status` | `"Drafting"` |
| StatusUpdate | `date` | dispatch ISO date |
| StatusUpdate | `summary` | `draft.Source Excerpt` or `draft.Name` |
| StatusUpdate | `presenterEmail` | (null — Presenter skipped) |
| StatusUpdate | `addressed` | (null — Addressed skipped) |
| Deliverable | `status` | `"Not Started"` |
| Deliverable | `timelineStart` | dispatch ISO date |
| Deliverable | `timelineEnd` | (null — single-date) |
| Deliverable | `ownerEmail` | First `DRI` on the draft, resolved to an email via home `users.retrieve`; `null` when DRI is empty or the user is a bot/group/no-email. |

#### Sync sources

None. The dispatcher is triggered by either the `dispatchDraft` tool or the `onDraftStatusChange` webhook (Notion database automation outbound webhook posting to this worker's URL). No managed syncs read or write this DB.

## Adding a new database

When you add a managed Notion database in a worker, append a section to this file with:
- the property table,
- the page-body shape (if any),
- the sync(s) that write to it.

Schema or mapping changes require an update here before the worker is "done."
