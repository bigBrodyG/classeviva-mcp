/**
 * The only module that talks to Spaggiari.
 *
 * Owns login, student-id derivation, token reuse and error mapping. Everything
 * above this layer deals in parsed JSON and never sees a URL or a header.
 */

import { API_HEADERS, url } from "./endpoints";
import type { LoginChoice, LoginResponse } from "./types";

/** ClasseViva sessions last 90 minutes; refresh a little early to avoid races. */
const SESSION_LIFETIME_MS = 90 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class ClasseVivaError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly apiError?: string,
	) {
		super(message);
		this.name = "ClasseVivaError";
	}
}

interface Session {
	token: string;
	/** Digits-only student id used in every `/students/{id}/...` path. */
	studentId: string;
	firstName?: string;
	lastName?: string;
	expiresAt: number;
}

/**
 * Derives the numeric student id the API expects from the `ident` returned by login.
 *
 * `ident` looks like `S12345678D`: a leading user-type letter and a trailing check
 * letter around the digits. The Python wrapper only stripped the leading letter,
 * leaving `12345678D`, which makes every endpoint return
 * `404 102:CvvRestApi/wrong uri — invalid student-id`. Only the digits are the id.
 */
export function studentIdFromIdent(ident: string): string {
	const digits = ident.replace(/\D/g, "");
	if (!digits) {
		throw new ClasseVivaError(`Cannot derive a student id from ident "${ident}"`, 0);
	}
	return digits;
}

/** `YYYY-MM-DD` -> `YYYYMMDD`, the format the API path segments use. */
export function toApiDate(date: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new ClasseVivaError(`Date must be YYYY-MM-DD, got "${date}"`, 0);
	}
	return date.replace(/-/g, "");
}

/**
 * Attempts a ClasseViva login with `ident: null`. A Genitore (parent) account
 * linked to more than one child answers with a `choices` list instead of a
 * token; a single-profile account logs in normally, and this returns `null`
 * so the caller proceeds exactly as it did before this existed.
 *
 * Deliberately separate from `ClasseVivaClient.ensureSession`: this call exists
 * only to discover whether a profile picker is needed, at OAuth-callback time,
 * before any `ClasseVivaClient` is constructed. Any token it receives is
 * discarded — the real session is established later, per request, with the
 * chosen `ident` once one is known.
 */
export async function discoverProfiles(uid: string, password: string): Promise<LoginChoice[] | null> {
	const response = await fetch(url.login(), {
		method: "POST",
		headers: API_HEADERS,
		body: JSON.stringify({ ident: null, pass: password, uid }),
	});

	// A `choices` body has been observed on both a success and a non-2xx
	// status in third-party reports, so both are parsed the same way rather
	// than branching on `response.ok`.
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return null;
	}

	const choices = (body as { choices?: LoginChoice[] } | null)?.choices;
	return Array.isArray(choices) && choices.length > 0 ? choices : null;
}

export class ClasseVivaClient {
	private session?: Session;

	constructor(
		private readonly uid: string,
		private readonly password: string,
		/** The chosen child's `ident`, for a Genitore account linked to more than
		 * one profile. `null` for a single-profile account, which is the only
		 * kind that ever logged in before profile selection existed. */
		private readonly ident: string | null = null,
	) {}

	/** Logs in if there is no usable token, then returns the live session. */
	async ensureSession(): Promise<Session> {
		if (this.session && Date.now() < this.session.expiresAt - REFRESH_MARGIN_MS) {
			return this.session;
		}

		const response = await fetch(url.login(), {
			method: "POST",
			headers: API_HEADERS,
			body: JSON.stringify({ ident: this.ident, pass: this.password, uid: this.uid }),
		});

		if (response.status === 422) {
			throw new ClasseVivaError("ClasseViva rejected the credentials", 422);
		}
		if (!response.ok) {
			throw await this.toError(response);
		}

		const data = (await response.json()) as LoginResponse;
		this.session = {
			token: data.token,
			studentId: studentIdFromIdent(data.ident),
			firstName: data.firstName,
			lastName: data.lastName,
			expiresAt: Date.parse(data.release) + SESSION_LIFETIME_MS,
		};
		return this.session;
	}

	/**
	 * Calls an authenticated endpoint and returns parsed JSON.
	 *
	 * `build` receives the student id so callers never construct paths themselves.
	 */
	async get<T>(build: (studentId: string) => string): Promise<T> {
		return this.request<T>("GET", build);
	}

	async post<T>(build: (studentId: string) => string): Promise<T> {
		return this.request<T>("POST", build);
	}

	/** Like `get`, but returns the raw response for binary payloads (attachments). */
	async getRaw(build: (studentId: string) => string): Promise<Response> {
		const session = await this.ensureSession();
		const response = await fetch(build(session.studentId), {
			method: "GET",
			headers: { ...API_HEADERS, "Z-Auth-Token": session.token },
		});
		if (!response.ok) throw await this.toError(response);
		return response;
	}

	private async request<T>(
		method: "GET" | "POST",
		build: (studentId: string) => string,
	): Promise<T> {
		const session = await this.ensureSession();
		const response = await fetch(build(session.studentId), {
			method,
			headers: { ...API_HEADERS, "Z-Auth-Token": session.token },
		});

		// An expired token reads as 401; drop the session and retry once.
		if (response.status === 401) {
			this.session = undefined;
			const retrySession = await this.ensureSession();
			const retry = await fetch(build(retrySession.studentId), {
				method,
				headers: { ...API_HEADERS, "Z-Auth-Token": retrySession.token },
			});
			if (!retry.ok) throw await this.toError(retry);
			return (await retry.json()) as T;
		}

		if (!response.ok) throw await this.toError(response);
		return (await response.json()) as T;
	}

	/** Turns an API error body into a message worth showing to a model. */
	private async toError(response: Response): Promise<ClasseVivaError> {
		let apiError: string | undefined;
		let detail = "";
		try {
			const body = (await response.json()) as { error?: string; message?: string };
			apiError = body.error;
			detail = body.message ?? body.error ?? "";
		} catch {
			detail = await response.text().catch(() => "");
		}

		// The two failures worth naming: they are the ones a caller can act on.
		if (apiError?.startsWith("122")) {
			return new ClasseVivaError(
				"Date range outside the current school year. ClasseViva only serves the " +
					"current year — previous years are not retrievable.",
				response.status,
				apiError,
			);
		}
		if (apiError?.startsWith("120")) {
			return new ClasseVivaError("Malformed date; expected YYYY-MM-DD", response.status, apiError);
		}

		return new ClasseVivaError(
			`ClasseViva returned ${response.status}${detail ? `: ${detail}` : ""}`,
			response.status,
			apiError,
		);
	}
}
