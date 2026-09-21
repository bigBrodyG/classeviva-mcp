/**
 * Shapes of the raw ClasseViva API responses.
 *
 * Derived from observed live responses. The API is neither versioned nor
 * documented by Spaggiari, so every field is treated as optional and compactors
 * must tolerate absent keys.
 */

export interface LoginResponse {
	ident: string;
	token: string;
	release: string;
	expire: string;
	firstName?: string;
	lastName?: string;
}

export interface Subject {
	id: number;
	description: string;
	order?: number;
	teachers?: { teacherId: string; teacherName: string }[];
}

export interface Period {
	periodCode: string;
	periodPos?: number;
	periodDesc?: string;
	periodLabel?: string;
	isFinal?: boolean;
	dateStart: string;
	dateEnd: string;
}

export interface Card {
	ident?: string;
	usrId?: number;
	firstName?: string;
	lastName?: string;
	birthDate?: string;
	fiscalCode?: string;
	schName?: string;
	schDedication?: string;
	schCity?: string;
	schProv?: string;
	miurSchoolCode?: string;
}

export interface Lesson {
	evtId: number;
	evtDate: string;
	evtCode?: string;
	evtHPos?: number;
	evtDuration?: number;
	classDesc?: string;
	authorName?: string;
	subjectId?: number;
	subjectCode?: string | null;
	subjectDesc?: string;
	lessonType?: string;
	lessonArg?: string;
}

export interface AgendaEvent {
	evtId: number;
	evtCode?: string;
	evtDatetimeBegin?: string;
	evtDatetimeEnd?: string;
	isFullDay?: boolean;
	notes?: string;
	authorName?: string;
	classDesc?: string;
	subjectId?: number;
	subjectDesc?: string;
	homeworkId?: number;
}

/**
 * A homework assignment from `/homeworks` — the text behind the agenda's
 * `AGHW` rows, whose `notes` is only "Compiti inseriti in Didattica".
 *
 * Unverified: taken from the Rust wrapper's struct (confused-ace-noises/
 * spaggiari-api), not from a live response. The attachment arrays are marked
 * "check whether these are right" in that source, hence `unknown[]`.
 */
export interface HomeworkItem {
	evtId?: number;
	evtCode?: string;
	teacherId?: string;
	teacherName?: string;
	homeworkDesc?: string;
	homeworkDone?: boolean;
	expiryDate?: string;
	subjectId?: number;
	subjectDesc?: string;
	lastStudentMsg?: string | null;
	lastTeacherMsg?: string | null;
	newMessages?: number;
	teacherFiles?: unknown[];
	teacherLinks?: unknown[];
	studentFiles?: unknown[];
}

export interface HomeworksResponse {
	items?: HomeworkItem[];
	/** Alternative key, in case the list is not under `items`. */
	homeworks?: HomeworkItem[];
}

export interface Grade {
	subjectId?: number;
	subjectDesc?: string;
	evtDate?: string;
	decimalValue?: number | null;
	displayValue?: string | null;
	displaPos?: number;
	notesForFamily?: string;
	color?: string;
	canceled?: boolean;
	underlined?: boolean;
	periodPos?: number;
	periodDesc?: string;
	componentDesc?: string;
	weightFactor?: number;
}

export interface Absence {
	evtId: number;
	evtCode?: string;
	evtDate?: string;
	evtHPos?: number | null;
	evtValue?: number;
	isJustified?: boolean;
	justifReasonCode?: string | null;
	justifReasonDesc?: string | null;
}

export interface Notice {
	pubId: number;
	pubDT?: string;
	readStatus?: boolean;
	evtCode?: string;
	cntId?: number;
	cntValidFrom?: string;
	cntValidTo?: string;
	cntValidInRange?: boolean;
	cntStatus?: string;
	cntTitle?: string;
	cntCategory?: string;
	cntHasAttach?: boolean;
	cntHasChanged?: boolean;
	needJoin?: boolean;
	needReply?: boolean;
	needFile?: boolean;
	needSign?: boolean;
	attachments?: { fileName: string; attachNum: number }[];
}

export interface CalendarDay {
	dayDate: string;
	dayOfWeek?: number;
	dayStatus: string;
}

export interface Note {
	evtId: number;
	evtDate?: string;
	evtText?: string;
	authorName?: string;
	readStatus?: boolean;
}

export interface Book {
	bookId?: number;
	isbnCode?: string;
	title?: string;
	subheading?: string;
	volume?: string;
	author?: string;
	publisher?: string;
	subjectDesc?: string;
	price?: number;
	toBuy?: boolean;
	newAdoption?: boolean;
	alreadyOwned?: boolean;
	alreadyInUse?: boolean;
	recommended?: boolean;
	recommendedFor?: string | null;
	coverUrl?: string;
	publisherUnlockCode?: string;
}

export interface BookCourse {
	courseId?: number;
	courseDesc?: string;
	books?: Book[];
}

export interface Overview {
	virtualClassesAgenda?: unknown[];
	lessons?: Lesson[];
	agenda?: AgendaEvent[];
	events?: Absence[];
	grades?: Grade[];
	notes?: Record<string, Note[]>;
}

export interface DocumentsResponse {
	documents?: Record<string, unknown>[];
	schoolReports?: Record<string, unknown>[];
}
