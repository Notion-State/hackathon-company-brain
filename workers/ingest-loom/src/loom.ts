/**
 * Loom enrichment client. Three independent fetchers, each behind its own
 * pacer, each catching failures and returning a status discriminant so the
 * caller can degrade gracefully:
 *
 *   - fetchOEmbed: documented public oEmbed endpoint. Stable. Returns
 *     title/thumbnail/duration. 403/404 here are the canonical signals for
 *     "private" vs "removed" videos.
 *
 *   - scrapeSharePage: parses OG/JSON-LD from the public share-page HTML.
 *     Stable in practice (it's the same metadata every social-share preview
 *     uses) but not contractually guaranteed.
 *
 *   - fetchGraphQL: Loom's UNDOCUMENTED public GraphQL endpoint. Used by
 *     yt-dlp and several third-party scrapers. Operation names drift —
 *     yt-dlp has shipped multiple fixes. The `enableGraphql` flag is the
 *     kill switch the operator flips when this starts breaking.
 *
 * No throws cross the module boundary: every fetcher returns a tagged-union
 * result and the caller picks a Sync Status from the combination.
 */

export type PacerLike = { wait: () => Promise<void> };

export type OEmbedResult =
	| {
			status: "ok";
			title: string;
			thumbnailUrl: string | null;
			durationSeconds: number | null;
			authorName: string | null;
	  }
	| { status: "private" }
	| { status: "unavailable" }
	| { status: "failed"; error: string };

export type SharePageResult =
	| {
			status: "ok";
			title: string | null;
			description: string | null;
			thumbnailUrl: string | null;
			uploadDate: string | null;
			durationSeconds: number | null;
	  }
	| { status: "private" }
	| { status: "unavailable" }
	| { status: "failed"; error: string };

export type GraphQLResult =
	| {
			status: "ok";
			ownerName: string | null;
			ownerEmail: string | null;
			createdAt: string | null;
			viewCount: number | null;
			commentCount: number | null;
			transcript: TranscriptCue[] | null;
	  }
	| { status: "skipped" }
	| { status: "failed"; error: string };

export type TranscriptCue = {
	startSeconds: number;
	text: string;
	speaker?: string;
};

export type LoomClient = {
	fetchOEmbed(shareUrl: string): Promise<OEmbedResult>;
	scrapeSharePage(shareUrl: string): Promise<SharePageResult>;
	fetchGraphQL(videoId: string): Promise<GraphQLResult>;
};

export type LoomClientConfig = {
	oembedPacer: PacerLike;
	pagePacer: PacerLike;
	graphqlPacer: PacerLike;
	enableGraphql: boolean;
	/** Test seam — defaults to global fetch. */
	fetchImpl?: typeof fetch;
};

/**
 * Parse a Loom video id from a share or embed URL. Accepts:
 *   - https://www.loom.com/share/<id>
 *   - https://loom.com/share/<id>
 *   - https://www.loom.com/embed/<id>
 *   - URLs with trailing query strings / fragments / paths
 *
 * Returns null for anything we don't recognize so the caller can downgrade
 * to "Failed" rather than calling Loom with junk.
 */
export function parseVideoId(shareUrl: string): string | null {
	if (!shareUrl) return null;
	try {
		const u = new URL(shareUrl);
		if (!/(^|\.)loom\.com$/.test(u.hostname)) return null;
		const m = u.pathname.match(/^\/(share|embed)\/([0-9a-f]{16,64})/i);
		if (!m) return null;
		return m[2]!.toLowerCase();
	} catch {
		return null;
	}
}

export function createLoomClient(config: LoomClientConfig): LoomClient {
	const fetchFn = config.fetchImpl ?? fetch;

	return {
		fetchOEmbed: (shareUrl) => fetchOEmbed(shareUrl, fetchFn, config.oembedPacer),
		scrapeSharePage: (shareUrl) => scrapeSharePage(shareUrl, fetchFn, config.pagePacer),
		fetchGraphQL: async (videoId) => {
			if (!config.enableGraphql) return { status: "skipped" };
			return fetchGraphQL(videoId, fetchFn, config.graphqlPacer);
		},
	};
}

// ---- oEmbed ----

async function fetchOEmbed(
	shareUrl: string,
	fetchFn: typeof fetch,
	pacer: PacerLike,
): Promise<OEmbedResult> {
	const endpoint = `https://www.loom.com/v1/oembed?url=${encodeURIComponent(shareUrl)}`;
	await pacer.wait();
	let res: Response;
	try {
		res = await fetchFn(endpoint, {
			headers: { accept: "application/json" },
		});
	} catch (err) {
		return { status: "failed", error: errorMessage(err) };
	}

	if (res.status === 403) return { status: "private" };
	if (res.status === 404) return { status: "unavailable" };
	if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };

	let body: unknown;
	try {
		body = await res.json();
	} catch (err) {
		return { status: "failed", error: `invalid JSON: ${errorMessage(err)}` };
	}

	if (!isObject(body)) return { status: "failed", error: "oEmbed body not an object" };

	return {
		status: "ok",
		title: stringOr(body.title, "Untitled Loom video"),
		thumbnailUrl: stringOrNull(body.thumbnail_url),
		durationSeconds: numberOrNull(body.duration),
		authorName: stringOrNull(body.author_name),
	};
}

// ---- Share-page scrape ----

async function scrapeSharePage(
	shareUrl: string,
	fetchFn: typeof fetch,
	pacer: PacerLike,
): Promise<SharePageResult> {
	await pacer.wait();
	let res: Response;
	try {
		res = await fetchFn(shareUrl, {
			headers: {
				accept: "text/html,application/xhtml+xml",
				// Some pages serve a stripped body to obvious bots; identifying
				// as a recognizable browser UA keeps OG/JSON-LD rendered.
				"user-agent":
					"Mozilla/5.0 (compatible; NotionWorkers/ingest-loom; +https://www.notion.so)",
			},
		});
	} catch (err) {
		return { status: "failed", error: errorMessage(err) };
	}

	if (res.status === 403) return { status: "private" };
	if (res.status === 404) return { status: "unavailable" };
	if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };

	let html: string;
	try {
		html = await res.text();
	} catch (err) {
		return { status: "failed", error: `read failed: ${errorMessage(err)}` };
	}

	return parseSharePageHtml(html);
}

/** Exported for tests. */
export function parseSharePageHtml(html: string): SharePageResult {
	const og = parseOpenGraph(html);
	const jsonLd = parseJsonLdVideoObject(html);

	const title = og.title ?? jsonLd.name ?? null;
	const description = og.description ?? jsonLd.description ?? null;
	const thumbnailUrl = og.image ?? jsonLd.thumbnailUrl ?? null;
	const uploadDate = jsonLd.uploadDate ?? null;
	const durationSeconds = jsonLd.durationSeconds ?? og.videoDurationSeconds ?? null;

	return {
		status: "ok",
		title,
		description,
		thumbnailUrl,
		uploadDate,
		durationSeconds,
	};
}

type OpenGraphFields = {
	title: string | null;
	description: string | null;
	image: string | null;
	videoDurationSeconds: number | null;
};

function parseOpenGraph(html: string): OpenGraphFields {
	const meta = (property: string): string | null => {
		// Match <meta property="og:foo" content="..."> in either attribute order.
		const re = new RegExp(
			`<meta[^>]*?(?:property|name)=["']${escapeRegex(property)}["'][^>]*?content=["']([^"']*)["']`,
			"i",
		);
		const m = html.match(re);
		if (m && m[1] != null) return decodeHtmlEntities(m[1]);
		const reReversed = new RegExp(
			`<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${escapeRegex(property)}["']`,
			"i",
		);
		const m2 = html.match(reReversed);
		return m2 && m2[1] != null ? decodeHtmlEntities(m2[1]) : null;
	};

	const rawDuration = meta("og:video:duration");
	const durationSeconds = rawDuration != null ? Number.parseInt(rawDuration, 10) : NaN;

	return {
		title: meta("og:title"),
		description: meta("og:description"),
		image: meta("og:image"),
		videoDurationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
	};
}

type JsonLdVideoObject = {
	name: string | null;
	description: string | null;
	thumbnailUrl: string | null;
	uploadDate: string | null;
	durationSeconds: number | null;
};

function parseJsonLdVideoObject(html: string): JsonLdVideoObject {
	const empty: JsonLdVideoObject = {
		name: null,
		description: null,
		thumbnailUrl: null,
		uploadDate: null,
		durationSeconds: null,
	};
	// Match every <script type="application/ld+json">…</script>; first
	// VideoObject wins (Loom pages typically have one).
	const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html))) {
		const body = (match[1] ?? "").trim();
		if (!body) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		const found = findVideoObject(parsed);
		if (found) return found;
	}
	return empty;
}

function findVideoObject(node: unknown): JsonLdVideoObject | null {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findVideoObject(item);
			if (found) return found;
		}
		return null;
	}
	if (!isObject(node)) return null;
	const type = node["@type"];
	const types = Array.isArray(type) ? type : [type];
	if (types.includes("VideoObject")) {
		return {
			name: stringOrNull(node.name),
			description: stringOrNull(node.description),
			thumbnailUrl: firstStringFromImageField(node.thumbnailUrl),
			uploadDate: stringOrNull(node.uploadDate),
			durationSeconds: parseIso8601Duration(stringOrNull(node.duration)),
		};
	}
	// Recurse into @graph or nested objects.
	for (const v of Object.values(node)) {
		const found = findVideoObject(v);
		if (found) return found;
	}
	return null;
}

function firstStringFromImageField(v: unknown): string | null {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		for (const item of v) {
			if (typeof item === "string") return item;
		}
	}
	return null;
}

/** Parse ISO 8601 duration like "PT1M33S" into seconds. Returns null on parse failure. */
export function parseIso8601Duration(raw: string | null): number | null {
	if (!raw) return null;
	const m = raw.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
	if (!m) return null;
	const [, d, h, mi, s] = m;
	const days = d ? Number.parseInt(d, 10) : 0;
	const hours = h ? Number.parseInt(h, 10) : 0;
	const mins = mi ? Number.parseInt(mi, 10) : 0;
	const secs = s ? Number.parseFloat(s) : 0;
	const total = days * 86400 + hours * 3600 + mins * 60 + secs;
	return total > 0 ? Math.round(total) : null;
}

// ---- GraphQL ----

/**
 * Loom's public GraphQL endpoint. The operation name and field shape are
 * UNDOCUMENTED. We send a single composite query that mirrors what Loom's
 * web client sends — if Loom renames a field, this whole call fails (we
 * mark it `failed` and the caller writes the row with what it has).
 *
 * To debug breaking changes, check yt-dlp's Loom extractor history; their
 * commits often pin the new operation/field names.
 */
async function fetchGraphQL(
	videoId: string,
	fetchFn: typeof fetch,
	pacer: PacerLike,
): Promise<GraphQLResult> {
	await pacer.wait();
	const query = GRAPHQL_QUERY;
	let res: Response;
	try {
		res = await fetchFn("https://www.loom.com/graphql", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"user-agent":
					"Mozilla/5.0 (compatible; NotionWorkers/ingest-loom; +https://www.notion.so)",
			},
			body: JSON.stringify({
				operationName: "GetVideoEnrichment",
				query,
				variables: { videoId },
			}),
		});
	} catch (err) {
		return { status: "failed", error: errorMessage(err) };
	}

	if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };

	let body: unknown;
	try {
		body = await res.json();
	} catch (err) {
		return { status: "failed", error: `invalid JSON: ${errorMessage(err)}` };
	}

	return normalizeGraphqlResponse(body);
}

/** Exported for tests. */
export function normalizeGraphqlResponse(body: unknown): GraphQLResult {
	if (!isObject(body)) return { status: "failed", error: "GraphQL body not an object" };
	if ("errors" in body && Array.isArray(body.errors) && body.errors.length > 0) {
		const first = body.errors[0];
		const msg = isObject(first) ? stringOr(first.message, "GraphQL error") : "GraphQL error";
		return { status: "failed", error: msg };
	}
	const data = isObject(body.data) ? body.data : null;
	if (!data) return { status: "failed", error: "GraphQL response missing data" };

	const video = isObject(data.video) ? data.video : null;
	const owner = video && isObject(video.owner) ? video.owner : null;
	const captions = video && isObject(video.captions) ? video.captions : null;
	const cues = captions && Array.isArray(captions.cues) ? captions.cues : null;

	return {
		status: "ok",
		ownerName: owner ? stringOrNull(owner.name) : null,
		ownerEmail: owner ? stringOrNull(owner.email) : null,
		createdAt: video ? stringOrNull(video.createdAt) : null,
		viewCount: video ? numberOrNull(video.viewCount) : null,
		commentCount: video ? numberOrNull(video.commentCount) : null,
		transcript: cues ? normalizeTranscript(cues) : null,
	};
}

function normalizeTranscript(raw: unknown[]): TranscriptCue[] {
	const out: TranscriptCue[] = [];
	for (const item of raw) {
		if (!isObject(item)) continue;
		const text = stringOrNull(item.text);
		if (!text) continue;
		out.push({
			startSeconds: numberOrNull(item.startSeconds) ?? 0,
			text,
			speaker: stringOrNull(item.speaker) ?? undefined,
		});
	}
	return out;
}

/**
 * Composite query: video metadata + owner + caption cues. This is the
 * field set Loom's own web client requests as of writing. The first time
 * any of these field names break, flip `LOOM_ENABLE_GRAPHQL=false` and
 * follow up with a pinned-version update.
 */
const GRAPHQL_QUERY = /* GraphQL */ `
	query GetVideoEnrichment($videoId: ID!) {
		video(id: $videoId) {
			id
			createdAt
			viewCount
			commentCount
			owner {
				name
				email
			}
			captions {
				cues {
					startSeconds
					text
					speaker
				}
			}
		}
	}
`;

// ---- Tiny helpers (kept local — no shared package in this repo) ----

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOr(v: unknown, fallback: string): string {
	return typeof v === "string" && v.length > 0 ? v : fallback;
}

function stringOrNull(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function numberOrNull(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number.parseFloat(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x2F;/gi, "/");
}
