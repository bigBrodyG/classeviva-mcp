/**
 * Builds the MCP server for one request.
 *
 * Kept out of the entry module so it can be exercised directly: the entry module
 * may only export handlers, so anything exported for testing has to live here.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { isAllowed } from "./access";
import { createAttachmentLinker, createAttachmentReader } from "./attachments";
import { ClasseVivaClient } from "./classeviva/client";
import { url } from "./classeviva/endpoints";
import { registerTools } from "./tools";
import type { Props } from "./workers-oauth-utils";

const SERVER_NAME = "classeviva";
const SERVER_VERSION = "0.1.0";

/**
 * Builds the MCP server for one request.
 *
 * The client is created per request. Cloudflare reuses isolates, so in practice a
 * warm isolate often still holds a valid ClasseViva token and skips the login
 * round-trip — but correctness never depends on that.
 */
export function buildServer(env: Env, origin: string, props?: Props): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

	if (!isAllowed(env, props?.email)) {
		// No tools, no data. A caller that got this far holds a valid OAuth token but
		// is not the identity this server exists for.
		return server;
	}

	// Each identity brings its own ClasseViva login, entered in the post-OTP
	// menu and carried on its OAuth grant. `env.CLASSEVIVA_ID`/`PASSWORD` are a
	// fallback only for a grant minted before that menu existed.
	const client = new ClasseVivaClient(
		props?.classevivaUid ?? env.CLASSEVIVA_ID,
		props?.classevivaPassword ?? env.CLASSEVIVA_PASSWORD,
		props?.classevivaIdent ?? null,
	);
	registerTools(server, {
		client,
		linkAttachment: createAttachmentLinker(env.LINK_SIGNING_KEY, origin),
		readAttachment: createAttachmentReader(env),
	});
	registerResources(server, client);
	registerPrompts(server);
	return server;
}

/** Static-ish context a client can hold without spending a tool call. */
function registerResources(server: McpServer, client: ClasseVivaClient): void {
	server.registerResource(
		"profile",
		"classeviva://profile",
		{
			title: "Student profile",
			description: "Student, school, school-year periods and subject list with teachers.",
			mimeType: "application/json",
		},
		async (uri) => {
			const [card, periods, subjects] = await Promise.all([
				client.get<{ card: unknown }>(url.card),
				client.get<{ periods: unknown }>(url.periods),
				client.get<{ subjects: unknown }>(url.subjects),
			]);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify({ ...card, ...periods, ...subjects }, null, 1),
					},
				],
			};
		},
	);
}

function registerPrompts(server: McpServer): void {
	server.registerPrompt(
		"week-review",
		{
			title: "How did this week go?",
			description: "Summarise lessons, grades, homework and absences for the past week.",
		},
		() => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text:
							"Use the `summary` tool for the last 7 days, then tell me how the week went: " +
							"new grades and how they move my averages, what was covered in class, any " +
							"absences, and what is still outstanding.",
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"whats-due",
		{
			title: "What do I have coming up?",
			description: "List homework and scheduled work for the next two weeks.",
		},
		() => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text:
							"Call `agenda` for the next 14 days and list what I have due, grouped by date, " +
							"with the subject name resolved via `profile`. Flag anything due in the next 48 hours.",
					},
				},
			],
		}),
	);
}
