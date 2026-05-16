/**
 * Markdown escaping shared between render-channels.ts and render-threads.ts.
 *
 * Copied verbatim from `workers/ingest-fireflies/src/render.ts:24-35`. The
 * project keeps it duplicated per-worker rather than extracted to a shared
 * package — see CLAUDE.md "Repository structure" for the per-worker
 * independence rationale.
 */
export function escapeMarkdown(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/`/g, "\\`")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/</g, "\\<")
		.replace(/>/g, "\\>")
		.replace(/#/g, "\\#");
}
