/**
 * Typed errors emitted by the push pipeline.
 *
 * Every error extends `PushToClientError`, carries a stable `code` string the
 * agent can branch on, and serializes via `toJSON()` so the tool boundary
 * delivers a structured payload (not just a stringified message).
 */

export type PushToClientErrorJson = {
	name: string;
	code: PushToClientErrorCode;
	message: string;
	details?: Record<string, unknown>;
};

export type PushToClientErrorCode =
	| "CLIENT_NOT_CONFIGURED"
	| "PRODUCTION_PUSH_NOT_AUTHORIZED"
	| "MISSING_REQUIRED_FIELD"
	| "DESTINATION_SCHEMA_MISMATCH"
	| "MARKDOWN_TOO_LONG"
	| "INTEGRATION_REVOKED"
	| "RATE_LIMITED"
	| "CLIENT_API_ERROR";

export abstract class PushToClientError extends Error {
	abstract readonly code: PushToClientErrorCode;

	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}

	toJSON(): PushToClientErrorJson {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
		};
	}
}

export class ClientNotConfigured extends PushToClientError {
	readonly code = "CLIENT_NOT_CONFIGURED" as const;
	readonly clientId: string;

	constructor(clientId: string) {
		super(
			`Client "${clientId}" is not configured. Configure CLIENT_TOKEN_${clientId.toUpperCase()} and CLIENT_DEST_DB_${clientId.toUpperCase()} and redeploy.`,
		);
		this.clientId = clientId;
	}

	override toJSON(): PushToClientErrorJson {
		return { ...super.toJSON(), details: { clientId: this.clientId } };
	}
}

export class ProductionPushNotAuthorized extends PushToClientError {
	readonly code = "PRODUCTION_PUSH_NOT_AUTHORIZED" as const;
	readonly clientId: string;

	constructor(clientId: string) {
		super(
			`Client "${clientId}" is in production mode; this push requires explicit allowProduction=true.`,
		);
		this.clientId = clientId;
	}

	override toJSON(): PushToClientErrorJson {
		return { ...super.toJSON(), details: { clientId: this.clientId } };
	}
}

export class MissingRequiredField extends PushToClientError {
	readonly code = "MISSING_REQUIRED_FIELD" as const;
	readonly docType: string;
	readonly field: string;

	constructor(docType: string, field: string) {
		super(
			`Push of docType "${docType}" requires field "${field}", which is missing or empty.`,
		);
		this.docType = docType;
		this.field = field;
	}

	override toJSON(): PushToClientErrorJson {
		return {
			...super.toJSON(),
			details: { docType: this.docType, field: this.field },
		};
	}
}

export type SchemaMismatchDetails = {
	missing: string[];
	wrongType: Array<{ name: string; expected: string; actual: string }>;
	unknownStatus?: string;
	validStatuses?: string[];
	unknownType?: string;
	validTypes?: string[];
	hint?: string;
};

export class DestinationSchemaMismatch extends PushToClientError {
	readonly code = "DESTINATION_SCHEMA_MISMATCH" as const;
	readonly details: SchemaMismatchDetails;

	constructor(details: SchemaMismatchDetails) {
		super(formatSchemaMismatch(details));
		this.details = details;
	}

	override toJSON(): PushToClientErrorJson {
		return { ...super.toJSON(), details: this.details };
	}
}

function formatSchemaMismatch(d: SchemaMismatchDetails): string {
	const parts: string[] = [];
	if (d.missing.length > 0) {
		parts.push(`missing properties: ${d.missing.join(", ")}`);
	}
	if (d.wrongType.length > 0) {
		const list = d.wrongType
			.map((w) => `${w.name} (expected ${w.expected}, got ${w.actual})`)
			.join(", ");
		parts.push(`wrong types: ${list}`);
	}
	if (d.unknownStatus !== undefined) {
		const valid = d.validStatuses?.length
			? ` (valid: ${d.validStatuses.join(", ")})`
			: "";
		parts.push(`unknown status "${d.unknownStatus}"${valid}`);
	}
	if (d.unknownType !== undefined) {
		const valid = d.validTypes?.length
			? ` (valid: ${d.validTypes.join(", ")})`
			: "";
		parts.push(`unknown type "${d.unknownType}"${valid}`);
	}
	if (d.hint) parts.push(d.hint);
	return parts.length > 0
		? `Destination schema mismatch: ${parts.join("; ")}.`
		: "Destination schema mismatch.";
}

export class MarkdownTooLong extends PushToClientError {
	readonly code = "MARKDOWN_TOO_LONG" as const;
	readonly byteCount: number;
	readonly limit: number;

	constructor(byteCount: number, limit: number) {
		super(`bodyMarkdown is ${byteCount} chars; limit is ${limit}.`);
		this.byteCount = byteCount;
		this.limit = limit;
	}

	override toJSON(): PushToClientErrorJson {
		return {
			...super.toJSON(),
			details: { byteCount: this.byteCount, limit: this.limit },
		};
	}
}

export class IntegrationRevoked extends PushToClientError {
	readonly code = "INTEGRATION_REVOKED" as const;
	readonly clientId: string;

	constructor(clientId: string, message?: string) {
		super(
			message ??
				`Notion API rejected the client integration (401/403). The client may have removed access from the destination database. Re-share the database with the integration via Connections.`,
		);
		this.clientId = clientId;
	}

	override toJSON(): PushToClientErrorJson {
		return { ...super.toJSON(), details: { clientId: this.clientId } };
	}
}

export class RateLimited extends PushToClientError {
	readonly code = "RATE_LIMITED" as const;
	readonly clientId: string;
	readonly retryAfterMs?: number;

	constructor(clientId: string, retryAfterMs?: number) {
		super(
			`Notion API rate limit hit for client "${clientId}"${
				retryAfterMs !== undefined ? ` (retry after ${retryAfterMs}ms)` : ""
			}.`,
		);
		this.clientId = clientId;
		this.retryAfterMs = retryAfterMs;
	}

	override toJSON(): PushToClientErrorJson {
		return {
			...super.toJSON(),
			details: { clientId: this.clientId, retryAfterMs: this.retryAfterMs },
		};
	}
}

export class ClientApiError extends PushToClientError {
	readonly code = "CLIENT_API_ERROR" as const;
	readonly clientId: string;
	readonly status: number;

	constructor(clientId: string, status: number, message: string) {
		super(`Notion API error ${status} for client "${clientId}": ${message}`);
		this.clientId = clientId;
		this.status = status;
	}

	override toJSON(): PushToClientErrorJson {
		return {
			...super.toJSON(),
			details: { clientId: this.clientId, status: this.status },
		};
	}
}
