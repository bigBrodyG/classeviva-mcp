# ClasseViva REST API — verified notes

Spaggiari publishes no specification for this API. Everything here was confirmed
against the live service on 2026-09-16 with a student account. Treat it as a field
report, not a contract: fields can appear, vanish or change without notice.

Base URL: `https://web.spaggiari.eu/rest/v1`

## Authentication

`POST /auth/login` with `{"ident": null, "pass": "...", "uid": "S1234567X"}` and these
headers, all three required:

```
content-type: application/json
Z-Dev-ApiKey: Tg1NWEwNGIgIC0K
User-Agent:   CVVS/std/4.2.3 Android/12
```

Returns `{ident, token, release, expire, firstName, lastName, ...}`. Send the token
as `Z-Auth-Token` on every subsequent request. Sessions last 90 minutes.

### The student id is digits only

`ident` looks like `S12345678D` — a user-type letter, the digits, and a trailing
check letter. Every `/students/{id}/...` path wants **only the digits**:

```
/students/12345678/periods   -> 200
/students/12345678D/periods  -> 404  102:CvvRestApi/wrong uri — invalid student-id
/students/S12345678D/periods -> 404  same
```

This is the single most common way to get a blanket 404 on every endpoint. The
Python wrapper this project replaced stripped only the leading letter and was
therefore broken end to end for accounts whose ident carries a check letter.

## Date rules

Path segments use `YYYYMMDD`, with no dashes.

The API serves **only the current school year**, and the upper bound of a range is
**today**, not the end of the year. Asking for more is a 404 whose message states
the accepted window:

```
/absences/details/20260901/20260916 -> 200
/absences/details/20260901/20260917 -> 404
   "dates must be beween 20260901 and 20260916; first date be NOT greater than second one"
/agenda/all/20250901/20260630       -> 404  122:CvvRestApi/invalid date range
```

Consequence: there is no way to retrieve a previous school year. Any archive
feature has to store the data as it goes.

Forward-looking endpoints are the exception — `agenda` and `overview` accept end
dates in the future, which is what makes "homework due next week" possible.

Error codes worth branching on: `120` malformed date, `122` range outside the
allowed window, `102` wrong URI (usually a bad student id), `151` no content.

## Endpoints

| Path | Method | Returns |
|---|---|---|
| `/students/{id}/card` | GET | `card` — identity and school |
| `/students/{id}/periods` | GET | `periods` — terms with start/end dates |
| `/students/{id}/subjects` | GET | `subjects` — subjects with teachers |
| `/students/{id}/grades` | GET | `grades` |
| `/students/{id}/absences/details[/{from}[/{to}]]` | GET | `events` |
| `/students/{id}/agenda/all/{from}/{to}` | GET | `agenda` |
| `/students/{id}/lessons/{from}/{to}[/{subjectId}]` | GET | `lessons` |
| `/students/{id}/calendar/all` | GET | `calendar` — one record per day |
| `/students/{id}/noticeboard` | GET | `items` |
| `/students/{id}/noticeboard/read/{evtCode}/{pubId}/101` | POST | marks as read |
| `/students/{id}/noticeboard/attach/{evtCode}/{pubId}/{attachNum}` | GET | the file |
| `/students/{id}/notes/all` | GET | `NTTE`, `NTCL`, `NTWN`, `NTST` |
| `/students/{id}/notes/{kind}/read/{evtId}` | POST | `event.evtText` |
| `/students/{id}/schoolbooks` | GET | `schoolbooks` |
| `/students/{id}/didactics` | GET | `didacticts` (sic) |
| `/students/{id}/documents` | **POST** | `documents`, `schoolReports` |
| `/students/{id}/overview/all/{from}/{to}` | GET | everything for a range |

`/documents` answers POST only — GET returns
`405 140:CvvRestApi/method not allowed for this resource`.

### Attachments

The last path segment of `noticeboard/attach` is `attachNum`, taken from the
notice's `attachments[].attachNum` (normally `1`). It is not a constant:

```
/noticeboard/attach/CF/90000001/1   -> 200 application/pdf, 200503 bytes
/noticeboard/attach/CF/90000001/101 -> 404 "there is nothing attached to this item"
```

The id must be `pubId`, not `cntId`. Using `cntId` returns
`151:CvvRestApi/no content available`.

### An attachment needs its notice opened first

A notice that has never been read will not release its attachment:

```
GET /noticeboard/attach/CF/90000002/1   -> 404 "item must first be read"
POST /noticeboard/read/CF/90000002/101  -> 200, marks it read
GET /noticeboard/attach/CF/90000002/1   -> 200 application/pdf
```

Measured across a real noticeboard: of seven notices with eight attachments between
them, only the one already read in the app downloaded. The other seven failed
identically.

This mirrors the web app, where a file is reachable only by opening the notice that
carries it, so there is no way around it — the read has to happen. It marks the
notice as read and cannot be undone. It does **not** sign: `needSign` stayed `true`
on every notice that required a signature after all eight attachments were fetched.

The trailing `101` on `noticeboard/read` is undocumented but works.

There is also an older route on the web app
(`bacheca_personale.php?action=file_download&com_id=...`) reached by posting
credentials to `AuthApi4.php`. It no longer works: it returns a 59 KB HTML page
instead of the file. Use the REST route.

## Response shapes worth knowing

`calendar/all` returns 396 records of `{dayDate, dayOfWeek, dayStatus}` where
`dayStatus` is `SD` (school), `HD` (holiday) or `NW` (non-working). Sundays are
`NW`, which breaks holiday and term stretches into short runs — 127 runs across a
year. Only `SD` carries information the other two do not imply.

`lessons` repeats `classDesc` (~43 chars) and `subjectDesc` (~72 chars) on every
row, and emits one row per hour: two consecutive hours of one lesson differ only in
`evtHPos`. Over a full year that is the largest payload the API produces.

`noticeboard` items carry `evento_id` duplicating `cntId`, `dinsert_allegato`
duplicating `pubDT`, and several `need*` booleans that are almost always false.

Note categories are `NTTE`, `NTCL`, `NTWN`, `NTST`. Spaggiari does not document
what the letters stand for; the list endpoint omits `evtText`, so the body needs a
second call per note.

Observed event codes: lessons `LSF0`, agenda `AGHW` (homework), noticeboard `CF`.
This list is certainly incomplete — treat unknown codes as pass-through.

## Unverified — pending a live test

`GET /students/{id}/homeworks` — the assignments behind the agenda's `AGHW` rows,
with `homeworkDesc` as the text. Not confirmed here: taken from three independent
open-source clients (`47PADO47/Classeviva.js`, `Casual76/classeviva-expressive`,
`confused-ace-noises/spaggiari-api`), the last of which types the item as
`{evtId, evtCode, teacherId, teacherName, homeworkDesc, homeworkDone, expiryDate,
subjectId, subjectDesc, lastStudentMsg, lastTeacherMsg, newMessages, teacherFiles,
teacherLinks, studentFiles}`. A fourth client (`ebordoni/classeviva-agent-diary`)
calls `/homeworks/index` instead; the `homework` tool tries the first path and
falls back to the second on a `102` wrong-uri response.

Open questions for the first live call, in order: which path answers; whether the
list sits under `items`; whether an item's `evtId` is the `homeworkId` the agenda
returns; whether `homeworkDesc` is the full text or a title. Answer them with
`format: "raw"`, then move this section up into the table.

## Endpoints that return nothing useful

- `/lessons/today` returned `{"lessons": []}` in every observation.
- `/didactics/item/{id}` returns the same payload as `/didactics`.
- `/users/{id}/avatar` did not respond.
- `overview`'s `virtualClassesAgenda` was always an empty list.
