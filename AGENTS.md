# hackathon-company-brain

A Notion-native "Company Brain" built on **Notion Workers**. Syncs from Fireflies.AI, Slack, and Loom feed internal Notion databases. Custom Agents analyze that data (calling Worker tools where needed) and write categorized pages into a shared review database. Approved pages are pushed to a client's Notion workspace, with an optional reverse sync back (TBD).

This file is the entry point for any agent working in this repo. Read it fully before making changes.

---

## Project documents

Two living docs in this repo. Read them before substantive work, and keep them updated as the project evolves.

- **`REQUIREMENTS.md`** — what we're building and why; scope, features, constraints.
- **`SCHEMA.md`** — database schemas, sync mappings, page property definitions.

If either is missing or out of date relative to the code, fix it (or ask) before continuing.

---

## Code standards

Code in this repo must be **effective, accurate, maintainable, performant, secure, and well tested**. Secrets go through `ntn workers env` — never committed. `.env` is gitignored; document required env vars in a committed `.env.example` (keys only, no values). Treat synced data and agent tool inputs as untrusted.

**When in doubt, ask.** Clarifying questions are cheaper than rework. Surface ambiguity early rather than guessing.

---

## Repository structure

**Monorepo, one folder per worker.** Each worker is an independent deployable unit — `ntn workers deploy` packages the current directory as a single worker, so separate folders give us separate deploys, secrets, and OAuth configs. That matches the platform; a single shared package would fight it.

```
hackathon-company-brain/
├── AGENTS.md / CLAUDE.md
├── README.md
├── package.json            # workspace config, shared dev deps
├── tsconfig.base.json
├── packages/
│   └── shared/             # shared types, Notion client wrappers, schema constants
└── workers/
    ├── ingest-fireflies/   # scaffold each with `ntn workers new`
    ├── ingest-slack/
    ├── ingest-loom/
    ├── agent-categorizer/
    ├── agent-summarizer/
    └── push-to-client/
```

**Rules for adding a worker:**

1. Scaffold with `ntn workers new` inside `workers/`. Don't hand-roll the structure.
2. Each worker has a `README.md` documenting its purpose, exposed tools, required secrets, and which agent(s) invoke it.
3. Shared code lives in `packages/shared` — never duplicated across workers.
4. Each worker keeps a `.env.example` (committed) alongside its `.env` (gitignored).

Tool `description` strings and `schema.describe()` text **are the agent's instructions** — write them as carefully as a prompt.

---

## Notion-specific workflow

See **References** at the bottom for docs links.

- **Scaffolding:** `ntn workers new` inside the target `workers/<name>/` directory. Follow the template's conventions.
- **Syncs:** use the **`/sync` slash command in Notion** to create new syncs against a worker's sync handler. Don't try to provision syncs manually.
- **Pre-demo, always:** `ntn workers sync trigger <key> --preview` on every active sync before a live demo run. Skipping this has burned us.
- **Client push:** the `push-to-client` worker holds the most sensitive credential in the project (the client workspace integration token). Default it to a staging target; only swap to production for an explicit production demo.

---

## Testing

Unit tests colocated as `src/**/*.test.ts`, mocking the Notion client. Integration tests via `ntn workers exec <toolName>` against a deployed dev worker. Shared fixtures (sample transcripts, messages, metadata) live in `packages/shared/fixtures/`.

A worker isn't "done" until: types check, tests pass, a `--preview` sync run produces expected output, and the worker README is updated.

---

## When to stop and ask

- `REQUIREMENTS.md` or `SCHEMA.md` is missing, out of date, or contradicts the code.
- A change would alter a database schema, sync mapping, or the approval-flow contract.
- A change touches the client-workspace push path or its credentials.
- You're about to add a new external dependency, new worker, or new top-level folder.
- A user instruction conflicts with anything in this file — flag it, don't silently override.

---

## References

- [Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Calling the Notion API from a worker](https://developers.notion.com/workers/guides/api-client)
- [Views API](https://developers.notion.com/guides/data-apis/working-with-views)
- [`ntn` CLI reference](https://developers.notion.com/cli/get-started/overview)
- [Workers template repo](https://github.com/makenotion/workers-template) — local mirror at `/repos/notion-workers`