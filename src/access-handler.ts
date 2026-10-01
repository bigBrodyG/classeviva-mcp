import { Buffer } from "node:buffer";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isAllowed } from "./access";
import { ClasseVivaClient, ClasseVivaError, discoverProfiles } from "./classeviva/client";
import type { LoginChoice } from "./classeviva/types";
import {
	addApprovedClient,
	createOAuthState,
	createProfileSelectionState,
	fetchUpstreamAuthToken,
	generateCSRFProtection,
	getUpstreamAuthorizeUrl,
	isClientApproved,
	OAuthError,
	type PendingProfileSelection,
	type Props,
	renderApprovalDialog,
	renderClasseVivaLoginForm,
	renderProfilePicker,
	resolveProfileSelectionState,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type EnvWithOauth = Env & { OAUTH_PROVIDER: OAuthHelpers };

export async function handleAccessRequest(
	request: Request,
	env: EnvWithOauth,
	_ctx: ExecutionContext,
) {
	const { pathname, searchParams } = new URL(request.url);

	if (request.method === "GET" && pathname === "/authorize") {
		// `parseAuthRequest` throws on a malformed or unknown client rather than
		// returning a falsy clientId, so the guard below never ran and a bad
		// client_id escaped as a 500 with a stack trace. Catch it and answer 400.
		let oauthReqInfo: AuthRequest;
		try {
			oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (error: any) {
			return new Response(
				`Invalid authorization request: ${error?.description ?? "malformed"}`,
				{ status: 400 },
			);
		}

		const { clientId } = oauthReqInfo;
		if (!clientId) {
			return new Response("Invalid request", { status: 400 });
		}

		// Check if client is already approved — no approval form so no CSRF cookie to clear
		if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
			const { stateToken, codeChallenge } = await createOAuthState(
				oauthReqInfo,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			return redirectToAccess(request, env, stateToken, codeChallenge);
		}

		// Generate CSRF protection for the approval form
		const { token: csrfToken, setCookie } = generateCSRFProtection();

		return renderApprovalDialog(request, {
			client: await env.OAUTH_PROVIDER.lookupClient(clientId),
			csrfToken,
			server: {
				description:
					"Personal MCP server for the ClasseViva school register. Access is limited " +
					"to a fixed allowlist of identities, each signing in with its own ClasseViva login.",
				logo: "https://www.cloudflare.com/favicon.ico",
				name: "ClasseViva MCP",
			},
			setCookie,
			state: { oauthReqInfo },
		});
	}

	if (request.method === "POST" && pathname === "/authorize") {
		try {
			// Read form data once at top
			const formData = await request.formData();

			// Validate CSRF token and capture clearCookie to expire the one-time-use token
			const csrfResult = validateCSRFToken(formData, request);

			// Extract state from form data
			const encodedState = formData.get("state");
			if (!encodedState || typeof encodedState !== "string") {
				return new Response("Missing state in form data", { status: 400 });
			}

			let state: { oauthReqInfo?: AuthRequest };
			try {
				state = JSON.parse(atob(encodedState));
			} catch (_e) {
				return new Response("Invalid state data", { status: 400 });
			}

			if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
				return new Response("Invalid request", { status: 400 });
			}

			// Add client to approved list
			const approvedClientCookie = await addApprovedClient(
				request,
				state.oauthReqInfo.clientId,
				env.COOKIE_ENCRYPTION_KEY,
			);

			// Create OAuth state
			const { stateToken, codeChallenge } = await createOAuthState(
				state.oauthReqInfo,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);

			// Build redirect headers — use Headers to support multiple Set-Cookie values
			const redirectHeaders = new Headers();
			redirectHeaders.append("Set-Cookie", approvedClientCookie);
			redirectHeaders.append("Set-Cookie", csrfResult.clearCookie);

			return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
		} catch (error: any) {
			console.error("POST /authorize error:", error);
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			// Unexpected non-OAuth error
			return new Response(`Internal server error: ${error.message}`, { status: 500 });
		}
	}

	if (request.method === "GET" && pathname === "/callback") {
		// Validate OAuth state (retrieves stored data from KV)
		let oauthReqInfo: AuthRequest;
		let codeVerifier: string;

		try {
			const result = await validateOAuthState(
				request,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			oauthReqInfo = result.oauthReqInfo;
			codeVerifier = result.codeVerifier;
		} catch (error: any) {
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			// Unexpected non-OAuth error
			return new Response("Internal server error", { status: 500 });
		}

		if (!oauthReqInfo.clientId) {
			return new Response("Invalid OAuth request data", { status: 400 });
		}

		// Exchange the code for an access token, including the PKCE verifier
		const [accessToken, idToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: env.ACCESS_CLIENT_ID,
			client_secret: env.ACCESS_CLIENT_SECRET,
			code: searchParams.get("code") ?? undefined,
			redirect_uri: new URL("/callback", request.url).href,
			upstream_url: env.ACCESS_TOKEN_URL,
			code_verifier: codeVerifier,
		});
		if (errResponse) {
			return errResponse;
		}

		const idTokenClaims = await verifyToken(env, idToken);
		const user = {
			email: idTokenClaims.email,
			name: idTokenClaims.name,
			sub: idTokenClaims.sub,
		};

		// Refuse to mint a token for anyone but the allowed identity. `buildServer`
		// checks again when serving, but stopping here means an unauthorised Access
		// identity never holds a valid token at all.
		if (!isAllowed(env, user.email)) {
			return new Response(
				`The account ${user.email ?? "(no email)"} is not authorised to use this server.`,
				{ status: 403 },
			);
		}

		// Every Access identity on the allowlist enters its own ClasseViva login
		// next — there is no shared account for the server to try on their
		// behalf, so this step cannot be skipped the way a single-profile
		// account used to skip the (now separate) profile picker.
		const { token: csrfToken, setCookie } = generateCSRFProtection();
		const pendingToken = await createProfileSelectionState(
			{ oauthReqInfo, user, accessToken },
			env.OAUTH_KV,
			env.COOKIE_ENCRYPTION_KEY,
		);
		return renderClasseVivaLoginForm(
			pendingToken,
			csrfToken,
			setCookie,
			new URL("/login", request.url).pathname,
		);
	}

	if (request.method === "POST" && pathname === "/login") {
		let formData: FormData;
		try {
			formData = await request.formData();
		} catch {
			return new Response("Invalid form submission", { status: 400 });
		}

		try {
			validateCSRFToken(formData, request);
		} catch (error: any) {
			if (error instanceof OAuthError) return error.toResponse();
			return new Response("Internal server error", { status: 500 });
		}

		const pendingToken = formData.get("token");
		const uid = formData.get("uid");
		const password = formData.get("password");
		if (!pendingToken || typeof pendingToken !== "string") {
			return new Response("Missing sign-in token", { status: 400 });
		}
		if (!uid || typeof uid !== "string" || !password || typeof password !== "string") {
			return new Response("Missing ClasseViva ID or password", { status: 400 });
		}

		let pending: PendingProfileSelection;
		try {
			pending = await resolveProfileSelectionState(pendingToken, env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);
		} catch (error: any) {
			if (error instanceof OAuthError) return error.toResponse();
			return new Response("Internal server error", { status: 500 });
		}

		// A Genitore login linked to one or more children answers with `choices`
		// instead of a token — getting that response at all already proves the
		// ID and password are correct, so only a login with no choices still
		// needs `ensureSession` to validate the credentials directly. Checking
		// `ensureSession` first would crash on a choices response: it has no
		// `token`/`ident` for `ensureSession` to read.
		let choices: LoginChoice[] | null;
		try {
			choices = await discoverProfiles(uid, password);
			if (!choices) {
				await new ClasseVivaClient(uid, password).ensureSession();
			}
		} catch (error) {
			const message =
				error instanceof ClasseVivaError
					? "ClasseViva rejected that ID or password."
					: "Could not reach ClasseViva — try again.";
			return await rerenderLoginForm(env, pending, message);
		}

		if (choices && choices.length > 1) {
			const { token: pickerCsrfToken, setCookie: pickerCookie } = generateCSRFProtection();
			const pickerToken = await createProfileSelectionState(
				{ ...pending, classevivaUid: uid, classevivaPassword: password },
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			return renderProfilePicker(
				choices,
				pickerToken,
				pickerCsrfToken,
				pickerCookie,
				new URL("/select-profile", request.url).pathname,
			);
		}

		return completeAndRedirect(env, pending, uid, password, choices?.[0]?.ident);
	}

	if (request.method === "POST" && pathname === "/select-profile") {
		let formData: FormData;
		try {
			formData = await request.formData();
		} catch {
			return new Response("Invalid form submission", { status: 400 });
		}

		try {
			// One-time use, like the CSRF token on the client-approval form.
			validateCSRFToken(formData, request);
		} catch (error: any) {
			if (error instanceof OAuthError) return error.toResponse();
			return new Response("Internal server error", { status: 500 });
		}

		const pendingToken = formData.get("token");
		const chosenIdent = formData.get("ident");
		if (!pendingToken || typeof pendingToken !== "string") {
			return new Response("Missing profile-selection token", { status: 400 });
		}
		if (!chosenIdent || typeof chosenIdent !== "string") {
			return new Response("Missing selected profile", { status: 400 });
		}

		let pending: PendingProfileSelection;
		try {
			pending = await resolveProfileSelectionState(pendingToken, env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);
		} catch (error: any) {
			if (error instanceof OAuthError) return error.toResponse();
			return new Response("Internal server error", { status: 500 });
		}

		if (!pending.classevivaUid || !pending.classevivaPassword) {
			return new Response("Missing ClasseViva credentials for this profile selection", { status: 400 });
		}

		// Re-check: the allowlist could in principle have changed during the
		// picker round trip, and this is cheap insurance against trusting a
		// decision made under a since-revoked identity.
		if (!isAllowed(env, pending.user.email)) {
			return new Response(
				`The account ${pending.user.email ?? "(no email)"} is not authorised to use this server.`,
				{ status: 403 },
			);
		}

		return completeAndRedirect(env, pending, pending.classevivaUid, pending.classevivaPassword, chosenIdent);
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Re-shows the credentials form after a failed login, carrying the same
 * pending OAuth request and Access identity forward under a fresh token —
 * the one just consumed by `resolveProfileSelectionState` is one-time use.
 */
async function rerenderLoginForm(
	env: EnvWithOauth,
	pending: PendingProfileSelection,
	message: string,
): Promise<Response> {
	const { token: csrfToken, setCookie } = generateCSRFProtection();
	const pendingToken = await createProfileSelectionState(
		{ oauthReqInfo: pending.oauthReqInfo, user: pending.user, accessToken: pending.accessToken },
		env.OAUTH_KV,
		env.COOKIE_ENCRYPTION_KEY,
	);
	return renderClasseVivaLoginForm(pendingToken, csrfToken, setCookie, "/login", message);
}

/** Mints the MCP token and returns the redirect back to the client. */
async function completeAndRedirect(
	env: EnvWithOauth,
	pending: Pick<PendingProfileSelection, "oauthReqInfo" | "user" | "accessToken">,
	classevivaUid: string,
	classevivaPassword: string,
	classevivaIdent: string | undefined,
): Promise<Response> {
	const { user, oauthReqInfo, accessToken } = pending;
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: user.name,
		},
		// This will be available on this.props inside MyMCP
		props: {
			accessToken,
			email: user.email,
			login: user.sub,
			name: user.name,
			classevivaUid,
			classevivaPassword,
			...(classevivaIdent ? { classevivaIdent } : {}),
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.sub,
	});

	return Response.redirect(redirectTo, 302);
}

async function redirectToAccess(
	request: Request,
	env: Env,
	stateToken: string,
	codeChallenge: string,
	extraHeaders: Headers = new Headers(),
) {
	const headers = new Headers(extraHeaders);
	headers.set(
		"location",
		getUpstreamAuthorizeUrl({
			client_id: env.ACCESS_CLIENT_ID,
			code_challenge: codeChallenge,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "openid email profile",
			state: stateToken,
			upstream_url: env.ACCESS_AUTHORIZATION_URL,
		}),
	);
	return new Response(null, { headers, status: 302 });
}

/**
 * Helper to get the Access public keys from the certs endpoint
 */
async function fetchAccessPublicKey(env: Env, kid: string) {
	if (!env.ACCESS_JWKS_URL) {
		throw new Error("access jwks url not provided");
	}
	// Not cached: each token verification re-fetches the JWKS. Access rotates
	// keys rarely, so an isolate-scoped cache (keyed by kid, short TTL) would cut
	// this to one fetch per cold start in exchange for a small window where a
	// freshly rotated key could be missed. Left uncached for now — correctness
	// over the extra round trip.
	const resp = await fetch(env.ACCESS_JWKS_URL);
	const keys = (await resp.json()) as {
		keys: (JsonWebKey & { kid: string })[];
	};
	const jwk = keys.keys.filter((key) => key.kid === kid)[0];
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{
			hash: "SHA-256",
			name: "RSASSA-PKCS1-v1_5",
		},
		false,
		["verify"],
	);
	return key;
}

/**
 * Parse a JWT into its respective pieces. Does not do any validation other than form checking.
 */
function parseJWT(token: string) {
	const tokenParts = token.split(".");

	if (tokenParts.length !== 3) {
		throw new Error("token must have 3 parts");
	}

	return {
		data: `${tokenParts[0]}.${tokenParts[1]}`,
		header: JSON.parse(Buffer.from(tokenParts[0], "base64url").toString()),
		payload: JSON.parse(Buffer.from(tokenParts[1], "base64url").toString()),
		signature: tokenParts[2],
	};
}

/**
 * Validates the provided token using the Access public key set
 */
async function verifyToken(env: Env, token: string) {
	const jwt = parseJWT(token);
	const key = await fetchAccessPublicKey(env, jwt.header.kid);

	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		Buffer.from(jwt.signature, "base64url"),
		Buffer.from(jwt.data),
	);

	if (!verified) {
		throw new Error("failed to verify token");
	}

	const claims = jwt.payload;
	const now = Math.floor(Date.now() / 1000);
	// Validate expiration
	if (claims.exp < now) {
		throw new Error("expired token");
	}

	return claims;
}
