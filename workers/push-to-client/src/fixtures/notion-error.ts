import { APIErrorCode, APIResponseError } from "@notionhq/client";

/**
 * Builds an `APIResponseError` for tests, filling required-but-unused fields
 * with sensible defaults so individual tests stay readable.
 */
export function makeApiError(opts: {
	code: APIErrorCode;
	status: number;
	message: string;
	headers?: Record<string, string>;
}): APIResponseError {
	return new APIResponseError({
		code: opts.code,
		status: opts.status,
		message: opts.message,
		headers: opts.headers ?? {},
		rawBodyText: "",
		additional_data: undefined,
		request_id: undefined,
	});
}
