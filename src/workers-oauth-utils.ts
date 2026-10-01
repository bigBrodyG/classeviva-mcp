// workers-oauth-utils.ts
// OAuth utility functions with CSRF and state validation security fixes

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

/**
 * OAuth 2.1 compliant error class.
 * Represents errors that occur during OAuth operations with standardized error codes and descriptions.
 */
export class OAuthError extends Error {
	/**
	 * Creates a new OAuthError
	 * @param code - The OAuth error code (e.g., "invalid_request", "invalid_grant")
	 * @param description - Human-readable error description
	 * @param statusCode - HTTP status code to return (defaults to 400)
	 */
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = "OAuthError";
	}

	/**
	 * Converts the error to a standardized OAuth error response
	 * @returns HTTP Response with JSON error body
	 */
	toResponse(): Response {
		return new Response(
			JSON.stringify({
				error: this.code,
				error_description: this.description,
			}),
			{
				status: this.statusCode,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

/**
 * Result from createOAuthState containing the state token and PKCE code challenge
 */
export interface OAuthStateResult {
	/**
	 * The generated state token (signed as {uuid}.{hmac}) to be used in OAuth authorization requests
	 */
	stateToken: string;
	/**
	 * The PKCE code challenge to include in the upstream authorization request
	 */
	codeChallenge: string;
}

/**
 * Result from validateOAuthState containing the original OAuth request info and PKCE verifier
 */
export interface ValidateStateResult {
	/**
	 * The original OAuth request information that was stored with the state token
	 */
	oauthReqInfo: AuthRequest;

	/**
	 * The PKCE code verifier to include in the upstream token exchange request
	 */
	codeVerifier: string;
}

/**
 * Result from generateCSRFProtection containing the CSRF token and cookie header
 */
export interface CSRFProtectionResult {
	/**
	 * The generated CSRF token to be embedded in forms
	 */
	token: string;

	/**
	 * Set-Cookie header value to send to the client
	 */
	setCookie: string;
}

/**
 * Result from validateCSRFToken containing the cookie to clear
 */
export interface ValidateCSRFResult {
	/**
	 * Set-Cookie header value to clear the CSRF cookie (one-time use per RFC 9700)
	 */
	clearCookie: string;
}

/**
 * Sanitizes text content for safe display in HTML by escaping special characters.
 * Use this for client names, descriptions, and other text content.
 *
 * @param text - The unsafe text that might contain HTML special characters
 * @returns A safe string with HTML special characters escaped
 *
 * @example
 * ```typescript
 * const safeName = sanitizeText("<script>alert('xss')</script>");
 * // Returns: "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"
 * ```
 */
export function sanitizeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Validates a URL for security.
 *
 * Implements RFC compliance:
 * - RFC 3986: Rejects control characters (not in allowed character set)
 * - RFC 3986: Validates URI structure using URL parser
 * - RFC 7591 §2: Client metadata URIs must point to valid web resources
 * - RFC 7591 §5: Protect users from malicious content (whitelist approach)
 *
 * Uses whitelist security: Only allows https: and http: schemes.
 * All other schemes (javascript:, data:, file:, etc.) are rejected.
 *
 * NOTE: This function only validates the URL structure and scheme. It does NOT
 * perform HTML escaping. If you need to use the URL in HTML context (href, src),
 * you must also call sanitizeText() on the result.
 *
 * @param url - The URL to validate
 * @returns The validated URL string, or empty string if validation fails
 *
 * @example
 * ```typescript
 * const validUrl = sanitizeUrl("https://example.com");
 * // Returns: "https://example.com"
 *
 * const blocked = sanitizeUrl("javascript:alert('xss')");
 * // Returns: "" (rejected - not in whitelist)
 *
 * // For use in HTML, also escape:
 * const htmlSafeUrl = sanitizeText(sanitizeUrl(userInput));
 * ```
 */
export function sanitizeUrl(url: string): string {
	const normalized = url.trim();

	if (normalized.length === 0) {
		return "";
	}

	// RFC 3986: Control characters are not in the allowed character set
	// Check C0 (0x00-0x1F) and C1 (0x7F-0x9F) control characters
	for (let i = 0; i < normalized.length; i++) {
		const code = normalized.charCodeAt(i);
		if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
			return "";
		}
	}

	// RFC 3986: Validate URI structure (scheme and path required)
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(normalized);
	} catch {
		return "";
	}

	// RFC 7591 §2: Client metadata URIs must point to valid web pages/resources
	// RFC 7591 §5: Protect users from malicious content
	// Whitelist only http/https schemes for web resources
	const allowedSchemes = ["https", "http"];

	const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
	if (!allowedSchemes.includes(scheme)) {
		return "";
	}

	// Return validated URL without HTML escaping
	// Caller should use sanitizeText() if HTML escaping is needed
	return normalized;
}

/**
 * Generates a new CSRF token and corresponding cookie for form protection
 * @returns Object containing the token and Set-Cookie header value
 */
export function generateCSRFProtection(): CSRFProtectionResult {
	const csrfCookieName = "__Host-CSRF_TOKEN";

	const token = crypto.randomUUID();
	const setCookie = `${csrfCookieName}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
	return { token, setCookie };
}

/**
 * Validates that the CSRF token from the form matches the token in the cookie.
 * Per RFC 9700 Section 2.1, CSRF tokens must be one-time use.
 *
 * @param formData - The parsed form data containing the CSRF token
 * @param request - The HTTP request containing cookies
 * @returns Object containing clearCookie header to invalidate the token
 * @throws {OAuthError} If CSRF token is missing or mismatched
 */
export function validateCSRFToken(formData: FormData, request: Request): ValidateCSRFResult {
	const csrfCookieName = "__Host-CSRF_TOKEN";

	const tokenFromForm = formData.get("csrf_token");

	if (!tokenFromForm || typeof tokenFromForm !== "string") {
		throw new OAuthError("invalid_request", "Missing CSRF token in form data", 400);
	}

	const cookieHeader = request.headers.get("Cookie") || "";
	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const csrfCookie = cookies.find((c) => c.startsWith(`${csrfCookieName}=`));
	const tokenFromCookie = csrfCookie ? csrfCookie.substring(csrfCookieName.length + 1) : null;

	if (!tokenFromCookie) {
		throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
	}

	if (tokenFromForm !== tokenFromCookie) {
		throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
	}

	// RFC 9700: CSRF tokens must be one-time use
	// Clear the cookie to prevent reuse
	const clearCookie = `${csrfCookieName}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

	return { clearCookie };
}

/**
 * Creates and stores OAuth state information, returning a signed state token and PKCE challenge.
 * The state token is HMAC-signed to prevent state injection attacks: forged values are rejected
 * before any KV operation because the signature check fails first.
 * @param oauthReqInfo - OAuth request information to store with the state
 * @param kv - Cloudflare KV namespace for storing OAuth state data
 * @param secret - Secret key used to HMAC-sign the state token
 * @param stateTTL - Time-to-live for OAuth state in seconds (defaults to 600)
 * @returns Object containing the signed state token and PKCE code challenge
 */
export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	secret: string,
	stateTTL = 600,
): Promise<OAuthStateResult> {
	const uuid = crypto.randomUUID();
	const { codeVerifier, codeChallenge } = await generatePKCE();

	// HMAC-sign the UUID so forged state values are rejected before touching KV
	const hmac = await signData(uuid, secret);
	const stateToken = `${uuid}.${hmac}`;

	// Store oauthReqInfo and codeVerifier together so they can be retrieved at callback
	await kv.put(`oauth:state:${uuid}`, JSON.stringify({ oauthReqInfo, codeVerifier }), {
		expirationTtl: stateTTL,
	});

	return { stateToken, codeChallenge };
}

/**
 * Validates OAuth state from the request, verifying the HMAC signature before any KV lookup,
 * and retrieving the stored OAuth request information and PKCE code verifier.
 * @param request - The HTTP request containing state parameter
 * @param kv - Cloudflare KV namespace for storing OAuth state data
 * @param secret - Secret key used to verify the state token HMAC signature
 * @returns Object containing the original OAuth request info, PKCE code verifier, and cookie to clear
 * @throws {OAuthError} If state is missing, has an invalid signature, or is expired/not found in KV
 */
export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
	secret: string,
): Promise<ValidateStateResult> {
	const url = new URL(request.url);
	const stateFromQuery = url.searchParams.get("state");

	if (!stateFromQuery) {
		throw new OAuthError("invalid_request", "Missing state parameter", 400);
	}

	// Verify HMAC signature before touching KV — rejects forged/injected state values immediately
	const dotIndex = stateFromQuery.lastIndexOf(".");
	if (dotIndex === -1) {
		throw new OAuthError("invalid_request", "Invalid state format", 400);
	}
	const uuid = stateFromQuery.substring(0, dotIndex);
	const hmac = stateFromQuery.substring(dotIndex + 1);

	const isValid = await verifySignature(hmac, uuid, secret);
	if (!isValid) {
		throw new OAuthError("invalid_request", "Invalid state signature", 400);
	}

	// Look up by UUID only after signature is verified
	const storedDataJson = await kv.get(`oauth:state:${uuid}`);
	if (!storedDataJson) {
		throw new OAuthError("invalid_request", "Invalid or expired state", 400);
	}

	let stored: { oauthReqInfo: AuthRequest; codeVerifier: string };
	try {
		stored = JSON.parse(storedDataJson) as { oauthReqInfo: AuthRequest; codeVerifier: string };
	} catch (_e) {
		throw new OAuthError("server_error", "Invalid state data", 500);
	}

	// Delete state from KV (one-time use)
	await kv.delete(`oauth:state:${uuid}`);

	return { oauthReqInfo: stored.oauthReqInfo, codeVerifier: stored.codeVerifier };
}

/**
 * Checks if a client has been previously approved by the user
 * @param request - The HTTP request containing cookies
 * @param clientId - The OAuth client ID to check
 * @param cookieSecret - Secret key used for signing and verifying cookie data
 * @returns True if the client is in the user's approved clients list
 */
export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approvedClients = await getApprovedClientsFromCookie(request, cookieSecret);
	return approvedClients?.includes(clientId) ?? false;
}

/**
 * Adds a client to the user's list of approved clients
 * @param request - The HTTP request containing existing cookies
 * @param clientId - The OAuth client ID to add
 * @param cookieSecret - Secret key used for signing and verifying cookie data
 * @returns Set-Cookie header value with the updated approved clients list
 */
export async function addApprovedClient(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<string> {
	const approvedClientsCookieName = "__Host-APPROVED_CLIENTS";
	const THIRTY_DAYS_IN_SECONDS = 2592000;

	const existingApprovedClients =
		(await getApprovedClientsFromCookie(request, cookieSecret)) || [];
	const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, clientId]));

	const payload = JSON.stringify(updatedApprovedClients);
	const signature = await signData(payload, cookieSecret);
	const cookieValue = `${signature}.${btoa(payload)}`;

	return `${approvedClientsCookieName}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${THIRTY_DAYS_IN_SECONDS}`;
}

/**
 * Configuration for the approval dialog
 */
export interface ApprovalDialogOptions {
	/**
	 * Client information to display in the approval dialog
	 */
	client: ClientInfo | null;
	/**
	 * Server information to display in the approval dialog
	 */
	server: {
		name: string;
		logo?: string;
		description?: string;
	};
	/**
	 * Arbitrary state data to pass through the approval flow
	 * Will be encoded in the form and returned when approval is complete
	 */
	state: Record<string, any>;
	/**
	 * CSRF token to include in the form
	 */
	csrfToken: string;
	/**
	 * Set-Cookie header for the CSRF token
	 */
	setCookie: string;
}

/**
 * Renders an approval dialog for OAuth authorization with CSRF protection
 * The dialog displays information about the client and server
 * and includes a form to submit approval with CSRF protection
 *
 * @param request - The HTTP request
 * @param options - Configuration for the approval dialog
 * @returns A Response containing the HTML approval dialog
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
	const { client, server, state, csrfToken, setCookie } = options;

	const encodedState = btoa(JSON.stringify(state));

	const serverName = sanitizeText(server.name);
	const clientName = client?.clientName ? sanitizeText(client.clientName) : "Unknown MCP Client";
	const serverDescription = server.description ? sanitizeText(server.description) : "";

	// Validate URLs then HTML-escape for safe use in attributes
	const logoUrl = server.logo ? sanitizeText(sanitizeUrl(server.logo)) : "";
	const clientUri = client?.clientUri ? sanitizeText(sanitizeUrl(client.clientUri)) : "";
	const policyUri = client?.policyUri ? sanitizeText(sanitizeUrl(client.policyUri)) : "";
	const tosUri = client?.tosUri ? sanitizeText(sanitizeUrl(client.tosUri)) : "";

	const contacts =
		client?.contacts && client.contacts.length > 0
			? sanitizeText(client.contacts.join(", "))
			: "";

	const redirectUris =
		client?.redirectUris && client.redirectUris.length > 0
			? client.redirectUris
					.map((uri) => {
						const validated = sanitizeUrl(uri);
						return validated ? sanitizeText(validated) : "";
					})
					.filter((uri) => uri !== "")
			: [];

	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          :root {
            --primary-color: #0070f3;
            --error-color: #f44336;
            --border-color: #e5e7eb;
            --text-color: #333;
            --background-color: #fff;
            --card-shadow: 0 8px 36px 8px rgba(0, 0, 0, 0.1);
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                         Helvetica, Arial, sans-serif, "Apple Color Emoji",
                         "Segoe UI Emoji", "Segoe UI Symbol";
            line-height: 1.6;
            color: var(--text-color);
            background-color: #f9fafb;
            margin: 0;
            padding: 0;
          }

          .container {
            max-width: 600px;
            margin: 2rem auto;
            padding: 1rem;
          }

          .precard {
            padding: 2rem;
            text-align: center;
          }

          .card {
            background-color: var(--background-color);
            border-radius: 8px;
            box-shadow: var(--card-shadow);
            padding: 2rem;
          }

          .header {
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 1.5rem;
          }

          .logo {
            width: 48px;
            height: 48px;
            margin-right: 1rem;
            border-radius: 8px;
            object-fit: contain;
          }

          .title {
            margin: 0;
            font-size: 1.3rem;
            font-weight: 400;
          }

          .alert {
            margin: 0;
            font-size: 1.5rem;
            font-weight: 400;
            margin: 1rem 0;
            text-align: center;
          }

          .description {
            color: #555;
          }

          .client-info {
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 1rem 1rem 0.5rem;
            margin-bottom: 1.5rem;
          }

          .client-name {
            font-weight: 600;
            font-size: 1.2rem;
            margin: 0 0 0.5rem 0;
          }

          .client-detail {
            display: flex;
            margin-bottom: 0.5rem;
            align-items: baseline;
          }

          .detail-label {
            font-weight: 500;
            min-width: 120px;
          }

          .detail-value {
            font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            word-break: break-all;
          }

          .detail-value a {
            color: inherit;
            text-decoration: underline;
          }

          .detail-value.small {
            font-size: 0.8em;
          }

          .external-link-icon {
            font-size: 0.75em;
            margin-left: 0.25rem;
            vertical-align: super;
          }

          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 1rem;
            margin-top: 2rem;
          }

          .button {
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-size: 1rem;
          }

          .button-primary {
            background-color: var(--primary-color);
            color: white;
          }

          .button-secondary {
            background-color: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-color);
          }

          @media (max-width: 640px) {
            .container {
              margin: 1rem auto;
              padding: 0.5rem;
            }

            .card {
              padding: 1.5rem;
            }

            .client-detail {
              flex-direction: column;
            }

            .detail-label {
              min-width: unset;
              margin-bottom: 0.25rem;
            }

            .actions {
              flex-direction: column;
            }

            .button {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="precard">
            <div class="header">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ""}
            <h1 class="title"><strong>${serverName}</strong></h1>
            </div>

            ${serverDescription ? `<p class="description">${serverDescription}</p>` : ""}
          </div>

          <div class="card">

            <h2 class="alert"><strong>${clientName || "A new MCP Client"}</strong> is requesting access</h1>

            <div class="client-info">
              <div class="client-detail">
                <div class="detail-label">Name:</div>
                <div class="detail-value">
                  ${clientName}
                </div>
              </div>

              ${
					clientUri
						? `
                <div class="client-detail">
                  <div class="detail-label">Website:</div>
                  <div class="detail-value small">
                    <a href="${clientUri}" target="_blank" rel="noopener noreferrer">
                      ${clientUri}
                    </a>
                  </div>
                </div>
              `
						: ""
				}

              ${
					policyUri
						? `
                <div class="client-detail">
                  <div class="detail-label">Privacy Policy:</div>
                  <div class="detail-value">
                    <a href="${policyUri}" target="_blank" rel="noopener noreferrer">
                      ${policyUri}
                    </a>
                  </div>
                </div>
              `
						: ""
				}

              ${
					tosUri
						? `
                <div class="client-detail">
                  <div class="detail-label">Terms of Service:</div>
                  <div class="detail-value">
                    <a href="${tosUri}" target="_blank" rel="noopener noreferrer">
                      ${tosUri}
                    </a>
                  </div>
                </div>
              `
						: ""
				}

              ${
					redirectUris.length > 0
						? `
                <div class="client-detail">
                  <div class="detail-label">Redirect URIs:</div>
                  <div class="detail-value small">
                    ${redirectUris.map((uri) => `<div>${uri}</div>`).join("")}
                  </div>
                </div>
              `
						: ""
				}

              ${
					contacts
						? `
                <div class="client-detail">
                  <div class="detail-label">Contact:</div>
                  <div class="detail-value">${contacts}</div>
                </div>
              `
						: ""
				}
            </div>

            <p>This MCP Client is requesting to be authorized on ${serverName}. If you approve, you will be redirected to complete authentication.</p>

            <form method="post" action="${new URL(request.url).pathname}">
              <input type="hidden" name="state" value="${encodedState}">
              <input type="hidden" name="csrf_token" value="${csrfToken}">

              <div class="actions">
                <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-primary">Approve</button>
              </div>
            </form>
          </div>
        </div>
      </body>
    </html>
  `;

	return new Response(htmlContent, {
		headers: {
			"Content-Security-Policy": "frame-ancestors 'none'",
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
			"X-Frame-Options": "DENY",
		},
	});
}

// --- Helper Functions ---

async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
	const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	return { codeVerifier, codeChallenge };
}

async function getApprovedClientsFromCookie(
	request: Request,
	cookieSecret: string,
): Promise<string[] | null> {
	const approvedClientsCookieName = "__Host-APPROVED_CLIENTS";

	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const targetCookie = cookies.find((c) => c.startsWith(`${approvedClientsCookieName}=`));

	if (!targetCookie) return null;

	const cookieValue = targetCookie.substring(approvedClientsCookieName.length + 1);
	const parts = cookieValue.split(".");

	if (parts.length !== 2) return null;

	const [signatureHex, base64Payload] = parts;
	const payload = atob(base64Payload);

	const isValid = await verifySignature(signatureHex, payload, cookieSecret);

	if (!isValid) return null;

	try {
		const approvedClients = JSON.parse(payload);
		if (
			!Array.isArray(approvedClients) ||
			!approvedClients.every((item) => typeof item === "string")
		) {
			return null;
		}
		return approvedClients as string[];
	} catch (_e) {
		return null;
	}
}

async function signData(data: string, secret: string): Promise<string> {
	const key = await importKey(secret);
	const enc = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifySignature(
	signatureHex: string,
	data: string,
	secret: string,
): Promise<boolean> {
	if (!signatureHex || !/^[0-9a-f]+$/i.test(signatureHex)) {
		return false;
	}
	const key = await importKey(secret);
	const enc = new TextEncoder();
	try {
		const signatureBytes = new Uint8Array(
			signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
		);
		return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer, enc.encode(data));
	} catch (_e) {
		return false;
	}
}

async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error("cookieSecret is required for signing cookies");
	}
	const enc = new TextEncoder();
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign", "verify"],
	);
}

/**
 * Constructs an upstream OAuth authorization URL with query parameters including PKCE
 */
export function getUpstreamAuthorizeUrl(params: {
	upstream_url: string;
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
	code_challenge: string;
	code_challenge_method?: string;
}): string {
	const url = new URL(params.upstream_url);
	url.searchParams.set("client_id", params.client_id);
	url.searchParams.set("redirect_uri", params.redirect_uri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", params.scope);
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.code_challenge);
	url.searchParams.set("code_challenge_method", params.code_challenge_method ?? "S256");
	return url.toString();
}

/**
 * Exchanges an authorization code for an access token from the upstream provider.
 * Sends the PKCE code_verifier to bind the exchange to the original authorization request.
 */
export async function fetchUpstreamAuthToken(params: {
	upstream_url: string;
	client_id: string;
	client_secret: string;
	code?: string;
	redirect_uri: string;
	code_verifier: string;
}): Promise<[string, string, null] | [null, null, Response]> {
	if (!params.code) {
		return [null, null, new Response("Missing authorization code", { status: 400 })];
	}

	const data = new URLSearchParams({
		client_id: params.client_id,
		client_secret: params.client_secret,
		code: params.code,
		grant_type: "authorization_code",
		redirect_uri: params.redirect_uri,
		code_verifier: params.code_verifier,
	});

	const response = await fetch(params.upstream_url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: data.toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return [
			null,
			null,
			new Response(`Failed to exchange code for token: ${errorText}`, {
				status: response.status,
			}),
		];
	}

	const body = (await response.json()) as any;

	const accessToken = body.access_token as string;
	if (!accessToken) {
		return [null, null, new Response("Missing access token", { status: 400 })];
	}

	const idToken = body.id_token as string;
	if (!idToken) {
		return [null, null, new Response("Missing id token", { status: 400 })];
	}
	return [accessToken, idToken, null];
}

/**
 * Props interface for upstream provider user data
 */
export interface Props {
	accessToken: string;
	email: string;
	login: string;
	name: string;
	/**
	 * The ClasseViva credentials entered in the post-OTP menu, bound to this
	 * identity's OAuth grant. Different Access identities can hold entirely
	 * different ClasseViva logins — there is no longer one shared account for
	 * the whole server.
	 */
	classevivaUid?: string;
	classevivaPassword?: string;
	/**
	 * The child `ident` chosen at connect time, for a ClasseViva login that is
	 * itself a Genitore account linked to more than one profile. Absent when
	 * the entered login has only one profile, in which case `ClasseVivaClient`
	 * logs in with `ident: null`.
	 */
	classevivaIdent?: string;
	[key: string]: unknown;
}

/**
 * One child offered by a Genitore login's `choices` response — see
 * `discoverProfiles` in `classeviva/client.ts`. Duplicated here rather than
 * imported so this OAuth-utilities module stays independent of the ClasseViva
 * client module, matching how `Props` itself carries no ClasseViva-specific
 * types beyond the plain `classevivaIdent` string.
 */
export interface ProfileChoice {
	ident: string;
	name: string;
	school?: string;
}

/**
 * Holds the OAuth request and the verified Access identity across the two
 * forms shown between Access sign-in and minting the MCP token: the
 * credentials menu first, then — only if that login turns out to be a
 * Genitore account linked to more than one child — the profile picker. The
 * same shape carries both stages; `classevivaUid`/`classevivaPassword` are
 * absent before the credentials form is submitted and present after.
 *
 * Same idea as `createOAuthState`/`validateOAuthState`, but for a decision
 * made inside this server rather than a round trip to an upstream provider,
 * so no PKCE verifier is involved.
 */
export interface PendingProfileSelection {
	oauthReqInfo: AuthRequest;
	user: { email: string; name: string; sub: string };
	accessToken: string;
	classevivaUid?: string;
	classevivaPassword?: string;
}

/**
 * Stores a pending profile selection and returns a signed token identifying
 * it, for the same forgery-resistance reason `createOAuthState` signs its
 * token: a forged value is rejected by the HMAC check before it ever reaches
 * KV.
 */
export async function createProfileSelectionState(
	data: PendingProfileSelection,
	kv: KVNamespace,
	secret: string,
	ttlSeconds = 600,
): Promise<string> {
	const uuid = crypto.randomUUID();
	const hmac = await signData(uuid, secret);
	await kv.put(`oauth:profile-pending:${uuid}`, JSON.stringify(data), {
		expirationTtl: ttlSeconds,
	});
	return `${uuid}.${hmac}`;
}

/**
 * Validates and consumes a profile-selection token minted by
 * `createProfileSelectionState`. One-time use, like `validateOAuthState`.
 */
export async function resolveProfileSelectionState(
	token: string,
	kv: KVNamespace,
	secret: string,
): Promise<PendingProfileSelection> {
	const dotIndex = token.lastIndexOf(".");
	if (dotIndex === -1) {
		throw new OAuthError("invalid_request", "Invalid profile-selection token", 400);
	}
	const uuid = token.substring(0, dotIndex);
	const hmac = token.substring(dotIndex + 1);

	const isValid = await verifySignature(hmac, uuid, secret);
	if (!isValid) {
		throw new OAuthError("invalid_request", "Invalid profile-selection signature", 400);
	}

	const stored = await kv.get(`oauth:profile-pending:${uuid}`);
	if (!stored) {
		throw new OAuthError("invalid_request", "Invalid or expired profile-selection state", 400);
	}
	await kv.delete(`oauth:profile-pending:${uuid}`);

	return JSON.parse(stored) as PendingProfileSelection;
}

/**
 * Renders the ClasseViva credentials menu shown right after Cloudflare Access
 * confirms identity, before an MCP token is minted. Every Access identity on
 * the allowlist enters its own ClasseViva login here — there is no shared
 * account for the server to fall back on.
 */
export function renderClasseVivaLoginForm(
	pendingToken: string,
	csrfToken: string,
	setCookie: string,
	formAction: string,
	error?: string,
): Response {
	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sign in to ClasseViva | ClasseViva MCP</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                         Helvetica, Arial, sans-serif;
            background-color: #f9fafb;
            color: #333;
            margin: 0;
          }
          .container { max-width: 420px; margin: 3rem auto; padding: 1rem; }
          .card {
            background-color: #fff;
            border-radius: 8px;
            box-shadow: 0 8px 36px 8px rgba(0, 0, 0, 0.1);
            padding: 2rem;
          }
          h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 0.5rem; }
          p.hint { color: #666; font-size: 0.9em; margin: 0 0 1.5rem; }
          .error {
            background: #fef2f2;
            color: #b91c1c;
            border: 1px solid #fecaca;
            border-radius: 6px;
            padding: 0.75rem 1rem;
            margin-bottom: 1rem;
            font-size: 0.9em;
          }
          label { display: block; font-weight: 500; margin-bottom: 0.4rem; font-size: 0.9em; }
          input[type="text"], input[type="password"] {
            width: 100%;
            box-sizing: border-box;
            padding: 0.6rem 0.75rem;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            font-size: 1rem;
            margin-bottom: 1rem;
          }
          .button {
            width: 100%;
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-size: 1rem;
            background-color: #0070f3;
            color: white;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h1>Sign in to ClasseViva</h1>
            <p class="hint">Your own login — the same ID and password you use in the ClasseViva app.</p>
            ${error ? `<div class="error">${sanitizeText(error)}</div>` : ""}
            <form method="post" action="${sanitizeText(formAction)}">
              <label for="uid">ClasseViva ID</label>
              <input type="text" id="uid" name="uid" autocomplete="username" required autofocus>
              <label for="password">Password</label>
              <input type="password" id="password" name="password" autocomplete="current-password" required>
              <input type="hidden" name="token" value="${sanitizeText(pendingToken)}">
              <input type="hidden" name="csrf_token" value="${csrfToken}">
              <button type="submit" class="button">Continue</button>
            </form>
          </div>
        </div>
      </body>
    </html>
  `;

	return new Response(htmlContent, {
		headers: {
			"Content-Security-Policy": "frame-ancestors 'none'",
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
			"X-Frame-Options": "DENY",
		},
	});
}

/**
 * Renders the "which profile" picker shown after Cloudflare Access confirms
 * identity but before an MCP token is minted, for a Genitore account linked to
 * more than one child. Styled after `renderApprovalDialog` for visual
 * consistency; a plain radio list rather than that dialog's client metadata,
 * since there is nothing here to review — just a name to pick.
 */
export function renderProfilePicker(
	choices: ProfileChoice[],
	pendingToken: string,
	csrfToken: string,
	setCookie: string,
	formAction: string,
): Response {
	const options = choices
		.map((choice, index) => {
			const name = sanitizeText(choice.name);
			const school = choice.school ? sanitizeText(choice.school) : "";
			return `
        <label class="choice">
          <input type="radio" name="ident" value="${sanitizeText(choice.ident)}" ${index === 0 ? "checked" : ""}>
          <span class="choice-name">${name}</span>
          ${school ? `<span class="choice-school">${school}</span>` : ""}
        </label>`;
		})
		.join("\n");

	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Choose a profile | ClasseViva MCP</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                         Helvetica, Arial, sans-serif;
            background-color: #f9fafb;
            color: #333;
            margin: 0;
          }
          .container { max-width: 480px; margin: 3rem auto; padding: 1rem; }
          .card {
            background-color: #fff;
            border-radius: 8px;
            box-shadow: 0 8px 36px 8px rgba(0, 0, 0, 0.1);
            padding: 2rem;
          }
          h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 1.5rem; }
          .choice {
            display: block;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            padding: 0.9rem 1rem;
            margin-bottom: 0.75rem;
            cursor: pointer;
          }
          .choice:has(input:checked) { border-color: #0070f3; background: #f0f7ff; }
          .choice input { margin-right: 0.6rem; }
          .choice-name { font-weight: 500; }
          .choice-school { display: block; margin-left: 1.4rem; font-size: 0.85em; color: #666; }
          .button {
            width: 100%;
            margin-top: 1.5rem;
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-size: 1rem;
            background-color: #0070f3;
            color: white;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h1>This account has more than one profile — which one is this?</h1>
            <form method="post" action="${sanitizeText(formAction)}">
              ${options}
              <input type="hidden" name="token" value="${sanitizeText(pendingToken)}">
              <input type="hidden" name="csrf_token" value="${csrfToken}">
              <button type="submit" class="button">Continue</button>
            </form>
          </div>
        </div>
      </body>
    </html>
  `;

	return new Response(htmlContent, {
		headers: {
			"Content-Security-Policy": "frame-ancestors 'none'",
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
			"X-Frame-Options": "DENY",
		},
	});
}
