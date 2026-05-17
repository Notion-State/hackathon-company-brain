/** Hand-built fixtures for `scrapeSharePage`. Not a real Loom payload — small
 * enough to be readable, structurally faithful to what Loom serves.
 */

export const SHARE_PAGE_FULL = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<title>Product walkthrough — Loom</title>
	<meta property="og:title" content="Product walkthrough">
	<meta property="og:description" content="Quick demo of the new dashboard, focused on the filters panel.">
	<meta property="og:image" content="https://cdn.loom.com/sessions/thumbnails/abc123-with-play.jpg">
	<meta property="og:video" content="https://www.loom.com/embed/abc123def456">
	<meta property="og:video:duration" content="225">
	<script type="application/ld+json">
		{
			"@context": "https://schema.org",
			"@type": "VideoObject",
			"name": "Product walkthrough",
			"description": "Quick demo of the new dashboard, focused on the filters panel.",
			"thumbnailUrl": "https://cdn.loom.com/sessions/thumbnails/abc123.jpg",
			"uploadDate": "2026-04-12T15:30:00.000Z",
			"duration": "PT3M45S",
			"contentUrl": "https://cdn.loom.com/sessions/abc123.mp4",
			"embedUrl": "https://www.loom.com/embed/abc123def456"
		}
	</script>
</head>
<body><div id="app"></div></body>
</html>`;

export const SHARE_PAGE_OG_ONLY = `<!doctype html>
<html>
<head>
	<meta property="og:title" content="Untitled but tagged">
	<meta property="og:description" content="No JSON-LD on this page.">
	<meta property="og:image" content="https://cdn.loom.com/sessions/thumbnails/xyz.jpg">
</head>
<body></body>
</html>`;

export const SHARE_PAGE_REVERSED_META = `<!doctype html>
<html><head>
	<meta content="Reversed attribute order works too" property="og:title">
	<meta name="og:description" content="Some HTML emits name= instead of property=.">
</head><body></body></html>`;

export const SHARE_PAGE_NESTED_JSONLD = `<!doctype html>
<html><head>
	<script type="application/ld+json">
		{
			"@context": "https://schema.org",
			"@graph": [
				{ "@type": "WebPage", "name": "Page wrapper" },
				{
					"@type": "VideoObject",
					"name": "Nested video object",
					"thumbnailUrl": ["https://cdn.loom.com/sessions/thumbnails/nested.jpg"],
					"duration": "PT45S",
					"uploadDate": "2026-01-01"
				}
			]
		}
	</script>
</head><body></body></html>`;

export const SHARE_PAGE_MALFORMED_JSONLD = `<!doctype html>
<html><head>
	<script type="application/ld+json">{ this is not json }</script>
	<meta property="og:title" content="Survives malformed JSON-LD">
</head><body></body></html>`;
