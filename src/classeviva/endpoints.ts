/**
 * ClasseViva REST API endpoints.
 *
 * Ported from `collegamenti.py` of the Python wrapper (Lioydiano/Classeviva, MIT),
 * with two corrections verified against the live API:
 *
 *  - `absencesFromTo` uses the 3-segment template. The original reused the
 *    `absencesFrom` one (2 placeholders) and passed 3 arguments, so the end date
 *    was silently dropped.
 *  - `noticeboardAttach` takes `attachNum` as its last segment. The original
 *    hardcoded `/101`, which returns 404: that segment is the attachment number,
 *    which comes from `attachments[].attachNum`.
 */

export const BASE = "https://web.spaggiari.eu/rest/v1";

/**
 * The trailing `101` on `noticeboard/read` is undocumented but works: verified
 * against the live API, which returns the notice body and marks it as read.
 * On the `attach` path the same `101` is wrong — there the segment is `attachNum`.
 */
const READ_PREVIEW_SEGMENT = 101;

export const url = {
	login: () => `${BASE}/auth/login`,
	status: () => `${BASE}/auth/status`,
	ticket: () => `${BASE}/auth/ticket`,

	documents: (id: string) => `${BASE}/students/${id}/documents`,
	checkDocument: (id: string, doc: string) => `${BASE}/students/${id}/documents/check/${doc}`,

	absences: (id: string) => `${BASE}/students/${id}/absences/details`,
	absencesFrom: (id: string, from: string) => `${BASE}/students/${id}/absences/details/${from}`,
	absencesFromTo: (id: string, from: string, to: string) =>
		`${BASE}/students/${id}/absences/details/${from}/${to}`,

	agendaFromTo: (id: string, from: string, to: string) =>
		`${BASE}/students/${id}/agenda/all/${from}/${to}`,
	agendaByCodeFromTo: (id: string, code: string, from: string, to: string) =>
		`${BASE}/students/${id}/agenda/${code}/${from}/${to}`,

	didactics: (id: string) => `${BASE}/students/${id}/didactics`,
	didacticsItem: (id: string, contentId: number) =>
		`${BASE}/students/${id}/didactics/item/${contentId}`,

	// Not in the Python wrapper. Three independent clients (Classeviva.js,
	// classeviva-expressive, spaggiari-api) call `/homeworks`; a newer one calls
	// `/homeworks/index`. Neither path is verified against the live API yet —
	// the tool tries the first and falls back to the second on a wrong-uri 404.
	homeworks: (id: string) => `${BASE}/students/${id}/homeworks`,
	homeworksIndex: (id: string) => `${BASE}/students/${id}/homeworks/index`,

	noticeboard: (id: string) => `${BASE}/students/${id}/noticeboard`,
	noticeboardRead: (id: string, evtCode: string, pubId: number) =>
		`${BASE}/students/${id}/noticeboard/read/${evtCode}/${pubId}/${READ_PREVIEW_SEGMENT}`,
	noticeboardAttach: (id: string, evtCode: string, pubId: number, attachNum: number) =>
		`${BASE}/students/${id}/noticeboard/attach/${evtCode}/${pubId}/${attachNum}`,

	lessonsToday: (id: string) => `${BASE}/students/${id}/lessons/today`,
	lessonsOnDay: (id: string, day: string) => `${BASE}/students/${id}/lessons/${day}`,
	lessonsFromTo: (id: string, from: string, to: string) =>
		`${BASE}/students/${id}/lessons/${from}/${to}`,
	lessonsFromToSubject: (id: string, from: string, to: string, subjectId: string) =>
		`${BASE}/students/${id}/lessons/${from}/${to}/${subjectId}`,

	calendar: (id: string) => `${BASE}/students/${id}/calendar/all`,
	calendarFromTo: (id: string, from: string, to: string) =>
		`${BASE}/students/${id}/calendar/${from}/${to}`,

	schoolbooks: (id: string) => `${BASE}/students/${id}/schoolbooks`,
	card: (id: string) => `${BASE}/students/${id}/card`,
	grades: (id: string) => `${BASE}/students/${id}/grades`,
	periods: (id: string) => `${BASE}/students/${id}/periods`,
	subjects: (id: string) => `${BASE}/students/${id}/subjects`,

	notes: (id: string) => `${BASE}/students/${id}/notes/all`,
	readNote: (id: string, kind: string, noteId: number) =>
		`${BASE}/students/${id}/notes/${kind}/read/${noteId}`,

	overviewFromTo: (id: string, from: string, to: string) =>
		`${BASE}/students/${id}/overview/all/${from}/${to}`,
} as const;

/** Required request headers — the API returns 403 without them. */
export const API_HEADERS: Record<string, string> = {
	"content-type": "application/json",
	"Z-Dev-ApiKey": "Tg1NWEwNGIgIC0K",
	"User-Agent": "CVVS/std/4.2.3 Android/12",
};

/** Note categories. Spaggiari does not document the expansions; these are inferred from use. */
export const NOTE_CATEGORIES = {
	NTTE: "teacher note",
	NTCL: "class note",
	NTWN: "warning",
	NTST: "disciplinary sanction",
} as const;

export type NoteCategory = keyof typeof NOTE_CATEGORIES;

/** Calendar `dayStatus` values. */
export const DAY_STATUS = {
	SD: "school day",
	HD: "holiday",
	NW: "non-working",
} as const;

/** Absence `evtCode` values. Unknown codes are passed through untranslated. */
export const ABSENCE_KIND: Record<string, string> = {
	ABA0: "absence",
	ABR0: "late arrival",
	ABR1: "late arrival",
	ABU0: "early leave",
};
