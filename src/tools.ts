/**
 * MCP tool definitions.
 *
 * Every tool takes an optional `format`: `compact` (default) runs the response
 * through the compactors, `raw` returns the API payload untouched as an escape
 * hatch for when a dropped field turns out to matter.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AttachmentLinker, AttachmentReader } from "./attachments";
import type { ClasseVivaClient } from "./classeviva/client";
import { ClasseVivaError, toApiDate } from "./classeviva/client";
import {
	compactAbsences,
	compactAgenda,
	compactBooks,
	compactCalendar,
	compactGrades,
	compactHomeworks,
	compactLessons,
	compactNotes,
	compactNoticeboard,
	compactProfile,
} from "./classeviva/compact";
import {
	addDays,
	resolveRange,
	schoolYearEnd,
	schoolYearEndOrToday,
	schoolYearStart,
	today,
} from "./classeviva/dates";
import { NOTE_CATEGORIES, url, type NoteCategory } from "./classeviva/endpoints";
import type {
	Absence,
	AgendaEvent,
	BookCourse,
	CalendarDay,
	Card,
	DocumentsResponse,
	Grade,
	HomeworksResponse,
	Lesson,
	Note,
	Notice,
	Overview,
	Period,
	Subject,
} from "./classeviva/types";

export const formatArg = z
	.enum(["compact", "raw"])
	.default("compact")
	.describe("`compact` strips repeated and empty fields; `raw` returns the untouched API payload.");

const dateArg = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(what);

/** A tool result is always a single JSON text block. */
export function json(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

export interface ToolDeps {
	client: ClasseVivaClient;
	/** Mints signed, expiring links for notice attachments. */
	linkAttachment: AttachmentLinker;
	/** Extracts an attachment's text so the model can read it. */
	readAttachment: AttachmentReader;
}

type Registrar = Pick<McpServer, "registerTool">;

export function registerTools(server: Registrar, deps: ToolDeps): void {
	const { client, linkAttachment, readAttachment } = deps;

	server.registerTool(
		"profile",
		{
			description:
				"Student identity, school, school-year periods, and the subject list with teachers. " +
				"Call this first: subject ids returned by other tools are resolved through it.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const [card, periods, subjects] = await Promise.all([
				client.get<{ card: Card }>(url.card),
				client.get<{ periods: Period[] }>(url.periods),
				client.get<{ subjects: Subject[] }>(url.subjects),
			]);
			return json(compactProfile(card.card, periods.periods, subjects.subjects));
		},
	);

	server.registerTool(
		"grades",
		{
			description:
				"Grades for the current school year, with averages computed overall, per subject and " +
				"per period. Cancelled grades and non-numeric marks are listed but excluded from averages.",
			inputSchema: z.object({
				subject: z.string().optional().describe("Filter by subject name, case-insensitive substring."),
				period: z.string().optional().describe("Filter by period description, e.g. '1° Quadrimestre'."),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ subject, period, format }) => {
			const raw = await client.get<{ grades: Grade[] }>(url.grades);
			if (format === "raw") return json(raw);

			let grades = raw.grades;
			if (subject) {
				const needle = subject.toLowerCase();
				grades = grades.filter((g) => g.subjectDesc?.toLowerCase().includes(needle));
			}
			if (period) {
				const needle = period.toLowerCase();
				grades = grades.filter((g) => g.periodDesc?.toLowerCase().includes(needle));
			}
			return json(compactGrades(grades));
		},
	);

	server.registerTool(
		"agenda",
		{
			description:
				"Homework and scheduled events. Defaults to the next 14 days. ClasseViva only serves the " +
				"current school year — earlier ranges are rejected by the API.",
			inputSchema: z.object({
				kind: z
					.enum(["homework", "all"])
					.default("all")
					.describe("`homework` keeps only AGHW entries."),
				from: dateArg("Start date, YYYY-MM-DD. Defaults to today.").optional(),
				to: dateArg("End date, YYYY-MM-DD. Defaults to 14 days out.").optional(),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ kind, from, to, format }) => {
			const range = resolveRange(from, to, { from: today(), to: addDays(today(), 14) });
			const raw = await client.get<{ agenda: AgendaEvent[] }>((id) =>
				url.agendaFromTo(id, toApiDate(range.from), toApiDate(range.to)),
			);
			if (format === "raw") return json(raw);
			const events = kind === "homework" ? raw.agenda.filter((e) => e.evtCode === "AGHW") : raw.agenda;
			return json(compactAgenda(events, range));
		},
	);

	server.registerTool(
		"homework",
		{
			description:
				"Homework assignments with their text. An `agenda` AGHW row only says \"Compiti " +
				"inseriti in Didattica\" and carries a `homeworkId`; the assignment itself lives here. " +
				"The API has no range parameter, so the whole list is fetched and filtered. " +
				"`/homeworks` is tried first, `/homeworks/index` when that path does not exist.",
			inputSchema: z.object({
				homeworkId: z
					.number()
					.optional()
					.describe(
						"`homeworkId` from an `agenda` AGHW row, matched against the item's `evtId`. " +
							"The two matched on every item of the first live call; an empty result with " +
							"a non-zero `count` would mean they differ — check with `format: \"raw\"`.",
					),
				subjectId: z.number().optional().describe("Subject id from `profile`."),
				from: dateArg("Keep assignments due on or after this date, YYYY-MM-DD.").optional(),
				to: dateArg("Keep assignments due on or before this date, YYYY-MM-DD.").optional(),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ homeworkId, subjectId, from, to, format }) => {
			let raw: HomeworksResponse;
			try {
				raw = await client.get<HomeworksResponse>(url.homeworks);
			} catch (error) {
				// 102 is "wrong uri": the path is not served, so try the newer spelling
				// before giving up. Any other failure is real and goes up as is.
				const wrongUri = error instanceof ClasseVivaError && error.apiError?.startsWith("102");
				if (!wrongUri) throw error;
				raw = await client.get<HomeworksResponse>(url.homeworksIndex);
			}
			if (format === "raw") return json(raw);

			const all = raw.items ?? raw.homeworks ?? [];
			const byId = homeworkId == null ? all : all.filter((h) => h.evtId === homeworkId);
			let items = byId;
			if (subjectId != null) items = items.filter((h) => h.subjectId === subjectId);
			// A missing bound is filled from the school year, so the envelope always
			// echoes the range that was applied. `expiryDate` may carry a time; compare
			// on the date part only.
			const range = from || to ? resolveRange(from, to) : undefined;
			if (range) {
				items = items.filter((h) => {
					const due = (h.expiryDate ?? "").slice(0, 10);
					return due >= range.from && due <= range.to;
				});
			}

			const result = compactHomeworks(items, range);
			if (all.length === 0) {
				result.note = `Empty list. Response keys: ${Object.keys(raw).join(", ") || "none"} — check with format: "raw".`;
			} else if (homeworkId != null && byId.length === 0) {
				result.note = `No item has evtId ${homeworkId}; ${all.length} assignments were returned. The agenda's homeworkId may not be this list's evtId — check with format: "raw".`;
			}
			return json(result);
		},
	);

	server.registerTool(
		"lessons",
		{
			description:
				"Lessons actually held, with topics. Consecutive periods of the same subject and topic " +
				"are merged into a single row (`hours: \"4-5\"`). Defaults to the last 7 days.",
			inputSchema: z.object({
				from: dateArg("Start date, YYYY-MM-DD.").optional(),
				to: dateArg("End date, YYYY-MM-DD.").optional(),
				subjectId: z.number().optional().describe("Subject id from `profile`."),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ from, to, subjectId, format }) => {
			const range = resolveRange(from, to, { from: addDays(today(), -7), to: today() });
			const raw = await client.get<{ lessons: Lesson[] }>((id) =>
				subjectId == null
					? url.lessonsFromTo(id, toApiDate(range.from), toApiDate(range.to))
					: url.lessonsFromToSubject(id, toApiDate(range.from), toApiDate(range.to), String(subjectId)),
			);
			return format === "raw" ? json(raw) : json(compactLessons(raw.lessons, range));
		},
	);

	server.registerTool(
		"absences",
		{
			description:
				"Absences, late arrivals and early leaves, with per-kind totals and an unjustified count.",
			inputSchema: z.object({
				from: dateArg("Start date, YYYY-MM-DD.").optional(),
				to: dateArg("End date, YYYY-MM-DD.").optional(),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ from, to, format }) => {
			// The API caps the upper bound at today and rejects anything later with
			// "dates must be beween <start> and <today>" — so the default cannot be
			// the end of the school year.
			const range = resolveRange(from, to, {
				from: schoolYearStart(),
				to: schoolYearEndOrToday(),
			});
			const raw = await client.get<{ events: Absence[] }>((id) =>
				url.absencesFromTo(id, toApiDate(range.from), toApiDate(range.to)),
			);
			return format === "raw" ? json(raw) : json(compactAbsences(raw.events, range));
		},
	);

	server.registerTool(
		"notes",
		{
			description:
				"Disciplinary notes across all four categories. The text comes with the list, so " +
				"reading a note costs nothing extra and marks nothing as read.",
			inputSchema: z.object({ format: formatArg }),
			annotations: { readOnlyHint: true },
		},
		async ({ format }) => {
			const raw = await client.get<Record<string, Note[]>>(url.notes);
			// The list already carries `evtText`, so there is nothing to expand. An
			// earlier version fell back to POST /notes/{kind}/read/{id} when the text
			// was missing — but that endpoint marks the note as read, which would have
			// made this tool quietly mutate the register despite its read-only hint.
			// A note without text is reported as it comes.
			return format === "raw" ? json(raw) : json(compactNotes(raw));
		},
	);

	server.registerTool(
		"noticeboard",
		{
			description:
				"School notices. Attachments come back as links to this server rather than bytes — " +
				"open one in a browser to download it, or use `read_attachment` to read its text. " +
				"Either way the notice gets marked as read, because ClasseViva will not release an " +
				"attachment for an unopened notice.",
			inputSchema: z.object({
				unreadOnly: z.boolean().default(false).describe("Keep only notices not yet marked as read."),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ unreadOnly, format }) => {
			const raw = await client.get<{ items: Notice[] }>(url.noticeboard);
			if (format === "raw") return json(raw);
			const items = unreadOnly ? raw.items.filter((i) => !i.readStatus) : raw.items;

			// Sign every attachment link up front: the compactor is synchronous.
			const links = new Map<string, string>();
			await Promise.all(
				items.flatMap((item) =>
					(item.attachments ?? []).map(async (a) => {
						const key = `${item.evtCode}/${item.pubId}/${a.attachNum}`;
						links.set(key, await linkAttachment(item.evtCode ?? "", item.pubId, a.attachNum));
					}),
				),
			);

			return json(compactNoticeboard(items, links));
		},
	);

	server.registerTool(
		"read_notice",
		{
			description:
				"Fetches a notice's full body AND marks it as read on ClasseViva. This writes to the " +
				"register and cannot be undone — only call it when the user asks to open or read a notice.",
			inputSchema: z.object({
				evtCode: z.string().describe("Notice `code` from `noticeboard`, e.g. 'CF'."),
				pubId: z.number().describe("Notice `pubId` from `noticeboard`."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ evtCode, pubId }) => {
			const raw = await client.post<unknown>((id) => url.noticeboardRead(id, evtCode, pubId));
			return json(raw);
		},
	);

	server.registerTool(
		"read_attachment",
		{
			description:
				"Reads a notice attachment and returns its text. Use this to answer questions about " +
				"what a notice says — the `url` from `noticeboard` only downloads the file, it does " +
				"not let you read it. Works on PDFs and images; images are described rather than " +
				"transcribed. ClasseViva will not serve an attachment for an unopened notice, so " +
				"this marks the notice as read, which cannot be undone. It never signs anything.",
			inputSchema: z.object({
				evtCode: z.string().describe("Notice `code` from `noticeboard`, e.g. 'CF'."),
				pubId: z.number().describe("Notice `pubId` from `noticeboard`."),
				attachNum: z.number().default(1).describe("From the notice's `attachments[].attachNum`."),
				fileName: z.string().optional().describe("The attachment's file name, if known."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ evtCode, pubId, attachNum, fileName }) => {
			const { text, truncated, bytes } = await readAttachment(
				evtCode,
				pubId,
				attachNum,
				fileName ?? "",
			);
			return json({
				fileName,
				sourceBytes: bytes,
				truncated: truncated || undefined,
				text,
			});
		},
	);

	server.registerTool(
		"calendar",
		{
			description:
				"School calendar collapsed into runs of consecutive days sharing a status (school day, " +
				"holiday, non-working). Use it to answer whether a given day has school.",
			inputSchema: z.object({
				from: dateArg("Start date, YYYY-MM-DD.").optional(),
				to: dateArg("End date, YYYY-MM-DD.").optional(),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ from, to, format }) => {
			const raw =
				from || to
					? await client.get<{ calendar: CalendarDay[] }>((id) => {
							const range = resolveRange(from, to);
							return url.calendarFromTo(id, toApiDate(range.from), toApiDate(range.to));
						})
					: await client.get<{ calendar: CalendarDay[] }>(url.calendar);
			return format === "raw" ? json(raw) : json(compactCalendar(raw.calendar));
		},
	);

	server.registerTool(
		"schoolbooks",
		{
			description: "Adopted textbooks by course, without cover images and publisher unlock codes.",
			inputSchema: z.object({ format: formatArg }),
			annotations: { readOnlyHint: true },
		},
		async ({ format }) => {
			const raw = await client.get<{ schoolbooks: BookCourse[] }>(url.schoolbooks);
			return format === "raw" ? json(raw) : json(compactBooks(raw.schoolbooks ?? []));
		},
	);

	server.registerTool(
		"didactics",
		{
			description: "Teaching material shared by teachers.",
			inputSchema: z.object({ format: formatArg }),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const raw = await client.get<{ didacticts?: unknown[] }>(url.didactics);
			// Spaggiari's own typo: the key is `didacticts`.
			return json({ count: raw.didacticts?.length ?? 0, data: raw.didacticts ?? [] });
		},
	);

	server.registerTool(
		"documents",
		{
			description: "Available documents and school reports (pagelle).",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () => {
			// This endpoint answers POST only; GET returns 405.
			const raw = await client.post<DocumentsResponse>(url.documents);
			return json({
				documents: raw.documents ?? [],
				schoolReports: raw.schoolReports ?? [],
			});
		},
	);

	server.registerTool(
		"summary",
		{
			description:
				"Lessons, agenda, grades, absences and notes for a date range in a single call. Prefer " +
				"this over several tools when the question is about a week or a month.",
			inputSchema: z.object({
				from: dateArg("Start date, YYYY-MM-DD. Defaults to the start of the school year.").optional(),
				to: dateArg("End date, YYYY-MM-DD. Defaults to the end of the school year.").optional(),
				format: formatArg,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ from, to, format }) => {
			const range = resolveRange(from, to, { from: schoolYearStart(), to: schoolYearEnd() });
			const raw = await client.get<Overview>((id) =>
				url.overviewFromTo(id, toApiDate(range.from), toApiDate(range.to)),
			);
			if (format === "raw") return json(raw);

			return json({
				range,
				lessons: compactLessons(raw.lessons ?? [], range),
				agenda: compactAgenda(raw.agenda ?? [], range),
				grades: compactGrades(raw.grades ?? []),
				absences: compactAbsences(raw.events ?? [], range),
				notes: compactNotes(raw.notes ?? {}),
			});
		},
	);
}

export { NOTE_CATEGORIES };
