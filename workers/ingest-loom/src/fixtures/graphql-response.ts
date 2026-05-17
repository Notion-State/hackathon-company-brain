export const GRAPHQL_OK = {
	data: {
		video: {
			id: "abc123def456",
			createdAt: "2026-04-12T15:30:00.000Z",
			viewCount: 142,
			commentCount: 3,
			owner: {
				name: "Alex Lee",
				email: "alex@notionstate.com",
			},
			captions: {
				cues: [
					{ startSeconds: 0, text: "Hey team, quick walkthrough.", speaker: "Alex Lee" },
					{ startSeconds: 6.5, text: "We just shipped the new filters panel." },
					{ startSeconds: 12, text: "Let me show you what's changed." },
				],
			},
		},
	},
};

export const GRAPHQL_ERROR = {
	errors: [{ message: "Cannot query field 'foo' on type 'Video'." }],
};

export const GRAPHQL_NO_CAPTIONS = {
	data: {
		video: {
			id: "abc123def456",
			createdAt: "2026-04-12T15:30:00.000Z",
			viewCount: 1,
			commentCount: 0,
			owner: { name: "Solo", email: "solo@example.com" },
			captions: null,
		},
	},
};
