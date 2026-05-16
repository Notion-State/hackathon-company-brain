import { describe, expect, it } from "vitest";

import {
	ClientApiError,
	ClientNotConfigured,
	DestinationSchemaMismatch,
	IntegrationRevoked,
	MarkdownTooLong,
	MissingRequiredField,
	ProductionPushNotAuthorized,
	PushToClientError,
	RateLimited,
} from "./errors.js";

describe("PushToClientError subclasses", () => {
	it("ClientNotConfigured has the right code and message", () => {
		const e = new ClientNotConfigured("acme");
		expect(e).toBeInstanceOf(PushToClientError);
		expect(e.code).toBe("CLIENT_NOT_CONFIGURED");
		expect(e.name).toBe("ClientNotConfigured");
		expect(e.message).toContain("CLIENT_TOKEN_ACME");
		expect(e.toJSON()).toEqual({
			name: "ClientNotConfigured",
			code: "CLIENT_NOT_CONFIGURED",
			message: e.message,
			details: { clientId: "acme" },
		});
	});

	it("ProductionPushNotAuthorized carries the clientId", () => {
		const e = new ProductionPushNotAuthorized("acme");
		expect(e.code).toBe("PRODUCTION_PUSH_NOT_AUTHORIZED");
		expect(e.toJSON().details).toEqual({ clientId: "acme" });
	});

	it("DestinationSchemaMismatch formats missing + wrongType + unknownStatus + unknownType", () => {
		const e = new DestinationSchemaMismatch({
			missing: ["Brain ID"],
			wrongType: [{ name: "Title", expected: "title", actual: "rich_text" }],
			unknownStatus: "Foo",
			validStatuses: ["Drafting", "Published"],
			unknownType: "Bar",
			validTypes: ["Contract", "Brand"],
		});
		expect(e.code).toBe("DESTINATION_SCHEMA_MISMATCH");
		expect(e.message).toContain("missing properties: Brain ID");
		expect(e.message).toContain("Title (expected title, got rich_text)");
		expect(e.message).toContain('unknown status "Foo"');
		expect(e.message).toContain("valid: Drafting, Published");
		expect(e.message).toContain('unknown type "Bar"');
		expect(e.toJSON().details).toMatchObject({
			missing: ["Brain ID"],
			unknownStatus: "Foo",
			unknownType: "Bar",
		});
	});

	it("DestinationSchemaMismatch handles a hint without any other issues", () => {
		const e = new DestinationSchemaMismatch({
			missing: [],
			wrongType: [],
			hint: "DB must contain exactly one data source",
		});
		expect(e.message).toContain("DB must contain exactly one data source");
	});

	it("MissingRequiredField carries docType + field", () => {
		const e = new MissingRequiredField("Docs", "type");
		expect(e.code).toBe("MISSING_REQUIRED_FIELD");
		expect(e.name).toBe("MissingRequiredField");
		expect(e.message).toContain("Docs");
		expect(e.message).toContain("type");
		expect(e.toJSON().details).toEqual({ docType: "Docs", field: "type" });
	});

	it("MarkdownTooLong reports counts", () => {
		const e = new MarkdownTooLong(60000, 50000);
		expect(e.code).toBe("MARKDOWN_TOO_LONG");
		expect(e.toJSON().details).toEqual({ byteCount: 60000, limit: 50000 });
	});

	it("IntegrationRevoked uses a default message when none provided", () => {
		const e = new IntegrationRevoked("acme");
		expect(e.code).toBe("INTEGRATION_REVOKED");
		expect(e.message).toMatch(/integration/i);
	});

	it("RateLimited optionally carries retryAfterMs", () => {
		const e = new RateLimited("acme", 1500);
		expect(e.code).toBe("RATE_LIMITED");
		expect(e.toJSON().details).toEqual({ clientId: "acme", retryAfterMs: 1500 });
	});

	it("ClientApiError preserves status and message", () => {
		const e = new ClientApiError("acme", 400, "bad request");
		expect(e.code).toBe("CLIENT_API_ERROR");
		expect(e.message).toContain("400");
		expect(e.message).toContain("bad request");
		expect(e.toJSON().details).toEqual({ clientId: "acme", status: 400 });
	});

	it("subclasses are instanceof PushToClientError and Error", () => {
		const e = new ClientApiError("acme", 500, "boom");
		expect(e).toBeInstanceOf(Error);
		expect(e).toBeInstanceOf(PushToClientError);
	});
});
