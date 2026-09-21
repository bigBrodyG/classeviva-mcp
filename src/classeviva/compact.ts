/**
 * Response compactors.
 *
 * ClasseViva repeats the same strings on every record: a full-year `lessons` call
 * is roughly 1000 rows carrying a 43-char class name and a 72-char subject name
 * each. These functions hoist whatever is constant into an envelope, drop fields
 * that are always null or always false, and collapse runs of identical records.
 *
 * Every compactor must tolerate missing keys — the API is undocumented and can
 * drop or rename fields without notice.
 */

import { ABSENCE_KIND, NOTE_CATEGORIES, type NoteCategory } from "./endpoints";
import type {
	Absence,
	AgendaEvent,
	Book,
	BookCourse,
	CalendarDay,
	Card,
	Grade,
	HomeworkItem,
	Lesson,
	Note,
	Notice,
	Period,
	Subject,
} from "./types";

/** Common envelope: what repeats lives here once, records go in `data`. */
export interface Envelope<T> {
	class?: string;
	subjects?: Record<string, string>;
	range?: { from: string; to: string };
	count: number;
	data: T;
	note?: string;
}

function subjectLegend(rows: { subjectId?: number; subjectDesc?: string }[]): Record<string, string> {
	const legend: Record<string, string> = {};
	for (const row of rows) {
		if (row.subjectId != null && row.subjectDesc) legend[String(row.subjectId)] = row.subjectDesc;
	}
	return legend;
}

/** Returns the value shared by every row, or undefined if it varies. */
function constant<T, K extends keyof T>(rows: T[], key: K): T[K] | undefined {
	if (rows.length === 0) return undefined;
	const first = rows[0][key];
	return rows.every((r) => r[key] === first) ? first : undefined;
}

// --- lessons -----------------------------------------------------------------

export interface CompactLesson {
	date: string;
	hours: string;
	subject?: number;
	teacher?: string;
	kind?: string;
	topic?: string;
}

/**
 * Merges consecutive periods of the same subject and topic into one row.
 * Two back-to-back hours of the same lesson differ only in `evtHPos`, so they
 * collapse to `hours: "4-5"`.
 */
export function compactLessons(lessons: Lesson[], range?: { from: string; to: string }): Envelope<CompactLesson[]> {
	const sorted = [...lessons].sort(
		(a, b) => a.evtDate.localeCompare(b.evtDate) || (a.evtHPos ?? 0) - (b.evtHPos ?? 0),
	);

	const merged: (CompactLesson & { lastHour: number })[] = [];
	for (const lesson of sorted) {
		const hour = lesson.evtHPos ?? 0;
		const previous = merged[merged.length - 1];
		const continues =
			previous &&
			previous.date === lesson.evtDate &&
			previous.subject === lesson.subjectId &&
			previous.topic === lesson.lessonArg &&
			previous.teacher === lesson.authorName &&
			hour === previous.lastHour + 1;

		if (continues) {
			previous.lastHour = hour;
			previous.hours = `${previous.hours.split("-")[0]}-${hour}`;
			continue;
		}

		merged.push({
			date: lesson.evtDate,
			hours: String(hour),
			lastHour: hour,
			subject: lesson.subjectId,
			teacher: lesson.authorName,
			kind: lesson.lessonType,
			topic: lesson.lessonArg,
		});
	}

	return {
		class: constant(lessons, "classDesc"),
		subjects: subjectLegend(lessons),
		range,
		count: merged.length,
		data: merged.map(({ lastHour: _lastHour, ...row }) => strip(row)),
	};
}

// --- calendar ----------------------------------------------------------------

export interface DayRun {
	from: string;
	to: string;
	days: number;
}

/**
 * Lists only the stretches when school is actually in session.
 *
 * Keeping all three statuses as runs was measured at 127 runs over a 396-day year
 * (22190 -> 9012 bytes, only -59%): every Sunday is `NW` and splits the holiday and
 * term stretches around it. Since the question this data answers is "is there
 * school on date X", emitting school runs alone and treating every other date as
 * closed cuts it to 38 runs without losing that answer.
 *
 * Use `format: "raw"` when the holiday/non-working distinction actually matters.
 */
export function compactCalendar(days: CalendarDay[]): Envelope<DayRun[]> {
	const sorted = [...days].sort((a, b) => a.dayDate.localeCompare(b.dayDate));
	const runs: DayRun[] = [];
	let previousDate: string | undefined;

	for (const day of sorted) {
		if (day.dayStatus !== "SD") continue;

		const current = runs[runs.length - 1];
		// Only extend across genuinely consecutive dates: a gap means a closure.
		const consecutive = current && previousDate && nextDay(previousDate) === day.dayDate;
		if (consecutive) {
			current.to = day.dayDate;
			current.days += 1;
		} else {
			runs.push({ from: day.dayDate, to: day.dayDate, days: 1 });
		}
		previousDate = day.dayDate;
	}

	return {
		count: runs.length,
		data: runs,
		note: "School days only. Any date outside these ranges is a closure (holiday or non-working day).",
	};
}

function nextDay(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

// --- grades ------------------------------------------------------------------

export interface CompactGrade {
	date?: string;
	subject?: number;
	value?: number | null;
	shown?: string | null;
	kind?: string;
	period?: string;
	weight?: number;
	comment?: string;
}

export interface GradesPayload {
	grades: CompactGrade[];
	averages: {
		overall: number | null;
		bySubject: { subject: string; average: number; count: number }[];
		byPeriod: { period: string; average: number; count: number }[];
	};
}

function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/**
 * Cancelled grades and grades with no numeric value (e.g. "assente") are kept in
 * the list but excluded from every average.
 */
export function compactGrades(grades: Grade[]): Envelope<GradesPayload> {
	const legend = subjectLegend(grades);
	const counted = grades.filter((g) => !g.canceled && typeof g.decimalValue === "number");

	const groupBy = (key: (g: Grade) => string | undefined) => {
		const buckets = new Map<string, number[]>();
		for (const grade of counted) {
			const bucket = key(grade);
			if (!bucket) continue;
			const list = buckets.get(bucket) ?? [];
			list.push(grade.decimalValue as number);
			buckets.set(bucket, list);
		}
		return [...buckets.entries()]
			.map(([name, values]) => ({ name, average: mean(values) as number, count: values.length }))
			.sort((a, b) => a.name.localeCompare(b.name));
	};

	if (grades.length === 0) {
		return { count: 0, data: { grades: [], averages: { overall: null, bySubject: [], byPeriod: [] } } };
	}

	// Silent failure guard. If the API renamed `decimalValue`, every grade would come
	// back with no value and every average would be null — and nothing would look
	// broken. Grades that exist but none of which count is worth saying out loud.
	const suspicious = grades.length > 0 && counted.length === 0;

	return {
		subjects: legend,
		count: grades.length,
		note: suspicious
			? "No grade carried a numeric value. Either all of them are cancelled, or the " +
				"API changed its field names — check with format: \"raw\"."
			: undefined,
		data: {
			grades: grades.map((g) =>
				strip({
					date: g.evtDate,
					subject: g.subjectId,
					value: g.decimalValue,
					shown: g.displayValue,
					kind: g.componentDesc,
					period: g.periodDesc,
					weight: g.weightFactor,
					comment: g.notesForFamily,
				}),
			),
			averages: {
				overall: mean(counted.map((g) => g.decimalValue as number)),
				bySubject: groupBy((g) => (g.subjectId != null ? String(g.subjectId) : undefined)).map(
					({ name, average, count }) => ({ subject: legend[name] ?? name, average, count }),
				),
				byPeriod: groupBy((g) => g.periodDesc).map(({ name, average, count }) => ({
					period: name,
					average,
					count,
				})),
			},
		},
	};
}

// --- agenda ------------------------------------------------------------------

export interface CompactAgendaEvent {
	id: number;
	start?: string;
	end?: string;
	allDay?: boolean;
	subject?: number;
	teacher?: string;
	text?: string;
	code?: string;
}

export function compactAgenda(
	events: AgendaEvent[],
	range?: { from: string; to: string },
): Envelope<CompactAgendaEvent[]> {
	return {
		class: constant(events, "classDesc"),
		subjects: subjectLegend(events),
		range,
		count: events.length,
		data: events.map((e) =>
			strip({
				id: e.evtId,
				start: e.evtDatetimeBegin,
				end: e.isFullDay ? undefined : e.evtDatetimeEnd,
				allDay: e.isFullDay || undefined,
				subject: e.subjectId,
				teacher: e.authorName,
				text: e.notes,
				code: e.evtCode,
			}),
		),
	};
}

// --- homeworks ---------------------------------------------------------------

export interface CompactHomework {
	id?: number;
	code?: string;
	subject?: number;
	teacher?: string;
	due?: string;
	done?: boolean;
	text?: string;
	files?: string[];
	links?: string[];
}

/**
 * Attachment entries have an unverified shape — possibly nested arrays of
 * objects, possibly strings. Flatten, keep a name-like field or the string
 * itself, drop the rest.
 */
function attachmentNames(entries: unknown[] | undefined): string[] | undefined {
	if (!entries?.length) return undefined;
	const names = entries.flat(2).flatMap((entry) => {
		if (typeof entry === "string") return [entry];
		if (entry && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			const name = record.fileName ?? record.name ?? record.title ?? record.url ?? record.link;
			return typeof name === "string" ? [name] : [];
		}
		return [];
	});
	return names.length ? names : undefined;
}

export function compactHomeworks(
	items: HomeworkItem[],
	range?: { from: string; to: string },
): Envelope<CompactHomework[]> {
	const sorted = [...items].sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? ""));
	return {
		subjects: subjectLegend(items),
		range,
		count: items.length,
		data: sorted.map((h) =>
			strip({
				id: h.evtId,
				code: h.evtCode,
				subject: h.subjectId,
				teacher: h.teacherName,
				due: h.expiryDate,
				done: h.homeworkDone || undefined,
				text: h.homeworkDesc,
				files: attachmentNames(h.teacherFiles),
				links: attachmentNames(h.teacherLinks),
			}),
		),
	};
}

// --- absences ----------------------------------------------------------------

export interface CompactAbsence {
	date?: string;
	kind: string;
	hour?: number | null;
	justified?: boolean;
	reason?: string | null;
}

export function compactAbsences(
	absences: Absence[],
	range?: { from: string; to: string },
): Envelope<{ events: CompactAbsence[]; totals: Record<string, number>; unjustified: number }> {
	const events = absences.map((a) => ({
		date: a.evtDate,
		kind: ABSENCE_KIND[a.evtCode ?? ""] ?? a.evtCode ?? "unknown",
		hour: a.evtHPos ?? undefined,
		justified: a.isJustified,
		reason: a.justifReasonDesc ?? undefined,
	}));

	const totals: Record<string, number> = {};
	for (const event of events) totals[event.kind] = (totals[event.kind] ?? 0) + 1;

	return {
		range,
		count: events.length,
		data: {
			events: events.map(strip),
			totals,
			unjustified: events.filter((e) => e.justified === false).length,
		},
	};
}

// --- noticeboard -------------------------------------------------------------

export interface CompactNotice {
	pubId: number;
	code?: string;
	date?: string;
	title?: string;
	read?: boolean;
	needsSignature?: boolean;
	validUntil?: string;
	attachments?: { fileName: string; attachNum: number; url: string }[];
}

/**
 * Drops `evento_id` (duplicates `cntId`), `dinsert_allegato` (duplicates `pubDT`)
 * and the `need*` flags when false. Attachments carry a link rather than bytes:
 * a notice PDF is around 200 KB, which is ~270 KB once base64-encoded.
 *
 * `links` maps `evtCode/pubId/attachNum` to a pre-signed URL. Signing is async and
 * this function is not, so the caller mints the links first — which also keeps the
 * compactors free of crypto and trivially testable.
 */
export function compactNoticeboard(
	notices: Notice[],
	links: Map<string, string>,
): Envelope<CompactNotice[]> {
	return {
		count: notices.length,
		data: notices.map((n) =>
			strip({
				pubId: n.pubId,
				code: n.evtCode,
				date: n.pubDT,
				title: n.cntTitle,
				read: n.readStatus,
				needsSignature: n.needSign || undefined,
				validUntil: n.cntValidTo,
				attachments: n.attachments?.length
					? n.attachments.map((a) => ({
							fileName: a.fileName,
							attachNum: a.attachNum,
							url: links.get(`${n.evtCode}/${n.pubId}/${a.attachNum}`) ?? "",
						}))
					: undefined,
			}),
		),
	};
}

// --- notes -------------------------------------------------------------------

export interface CompactNote {
	id: number;
	category: string;
	date?: string;
	author?: string;
	text?: string;
	read?: boolean;
}

export function compactNotes(byCategory: Record<string, Note[]>): Envelope<CompactNote[]> {
	const rows: CompactNote[] = [];
	for (const [code, notes] of Object.entries(byCategory)) {
		for (const note of notes ?? []) {
			rows.push(
				strip({
					id: note.evtId,
					category: NOTE_CATEGORIES[code as NoteCategory] ?? code,
					date: note.evtDate,
					author: note.authorName,
					text: note.evtText,
					read: note.readStatus,
				}),
			);
		}
	}
	rows.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
	return { count: rows.length, data: rows };
}

// --- schoolbooks -------------------------------------------------------------

export interface CompactBook {
	title?: string;
	author?: string;
	publisher?: string;
	isbn?: string;
	subject?: string;
	volume?: string;
	price?: number;
	toBuy?: boolean;
}

/** Drops `coverUrl`, `publisherUnlockCode`, `recommendedFor` and the false booleans. */
export function compactBooks(courses: BookCourse[]): Envelope<{ course?: string; books: CompactBook[] }[]> {
	const data = courses.map((course) => ({
		course: course.courseDesc,
		books: (course.books ?? []).map((b: Book) =>
			strip({
				title: b.title,
				author: b.author,
				publisher: b.publisher,
				isbn: b.isbnCode,
				subject: b.subjectDesc,
				volume: b.volume,
				price: b.price,
				toBuy: b.toBuy || undefined,
			}),
		),
	}));
	return { count: data.reduce((n, c) => n + c.books.length, 0), data };
}

// --- profile -----------------------------------------------------------------

export interface Profile {
	student: string;
	school: string;
	city?: string;
	birthDate?: string;
	periods: { code: string; label?: string; from: string; to: string; final?: boolean }[];
	subjects: { id: number; name: string; teachers: string[] }[];
}

export function compactProfile(card: Card, periods: Period[], subjects: Subject[]): Profile {
	return {
		student: [card.firstName, card.lastName].filter(Boolean).join(" "),
		school: [card.schName, card.schDedication].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
		city: card.schCity,
		birthDate: card.birthDate,
		periods: periods.map((p) => ({
			code: p.periodCode,
			label: p.periodLabel ?? p.periodDesc,
			from: p.dateStart,
			to: p.dateEnd,
			final: p.isFinal || undefined,
		})),
		subjects: subjects.map((s) => ({
			id: s.id,
			name: s.description,
			teachers: (s.teachers ?? []).map((t) => t.teacherName),
		})),
	};
}

// --- helpers -----------------------------------------------------------------

/** Removes keys whose value is undefined, null or an empty string. */
function strip<T extends Record<string, unknown>>(obj: T): T {
	const out = {} as T;
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null || value === "") continue;
		out[key as keyof T] = value as T[keyof T];
	}
	return out;
}
