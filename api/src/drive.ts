/**
 * Synology Drive's own REST API (v2), the way the app keeps a document: `files`
 * to read a file's metadata, `files/download` to read its text, `files/upload`
 * to write one. It sits beside `synology.ts` because it is a different door.
 * DSM's legacy WebAPI answers everything at `/webapi/entry.cgi` with the api
 * name in a form field; Drive is ordinary REST under
 * `/api/SynologyDrive/default/v2`. What they share is what `synology.ts`
 * exports: `reach` to send, `jsonBody` to read, `verdict` to turn DSM's
 * `success: false` at HTTP 200 into the error it is, and `bytesOrRefusal` to
 * tell a download's bytes from its refusal.
 *
 * The session id travels as the cookie `id=<sid>`, never as `_sid` in the URL or
 * the body. Drive's spec declares its auth in `securitySchemes` as the `id`
 * cookie, and a query string lands in the NAS's access log. The sid stays in
 * memory: it is not logged, not put in a URL and not written to a file.
 *
 * Every write is `PUT files/upload` with `conflict_action: version`, so a file
 * that is already there gains a version rather than being replaced or refused,
 * and the old text stays recoverable. `POST files` is used only with
 * `type=folder`, to make a folder; a move is `POST files/move`, which never
 * overwrites (`conflict_action: stop`).
 *
 * `properties` and `app_properties` are read-only in the spec, so nothing here
 * reads or writes them. What the app needs to remember about a file lives in the
 * file, or in the log.
 */

import { randomUUID } from 'node:crypto';

import { DSM_URL } from './auth.ts';
import { CALL_TIMEOUT_MS, SynologyError, bytesOrRefusal, fetchFor, jsonBody, quoted, reach, verdict } from './synology.ts';
import type { DsmFetch } from './synology.ts';

/** What errors carry as their `api`, in place of the legacy API name Drive does not have. */
export const DRIVE_API = 'SYNO.SynologyDrive.Files';
export const DRIVE_BASE = '/api/SynologyDrive/default/v2';

export interface DriveFile {
  file_id: string;
  permanent_link: string;
  name: string;
  path: string;
  display_path: string;
  type: 'file' | 'dir';
  hash: string;
  /** `String()` of Drive's int64, so it is never rounded on the way through JSON. */
  version_id: string;
  change_id: number;
  max_id: number;
  /** Epoch seconds. */
  modified_time: number;
  removed: boolean;
  content_snippet: string;
}

/** A file as Drive spells it: `version_id` is a number here, and some fields may be absent. */
type RawFile = Partial<Omit<DriveFile, 'version_id'>> & { version_id?: number | string };

const driveFile = (r: RawFile): DriveFile => ({
  file_id: String(r.file_id ?? ''),
  permanent_link: r.permanent_link ?? '',
  name: r.name ?? '',
  path: r.path ?? '',
  display_path: r.display_path ?? '',
  type: r.type === 'dir' ? 'dir' : 'file',
  hash: r.hash ?? '',
  version_id: String(r.version_id ?? 0),
  change_id: r.change_id ?? 0,
  max_id: r.max_id ?? 0,
  modified_time: r.modified_time ?? 0,
  removed: r.removed === true,
  content_snippet: r.content_snippet ?? '',
});

/** Drive takes a file by its permanent link wherever it takes a path. */
export const byLink = (link: string): string => `link:${link}`;

const cookieFor = (sid: string): Record<string, string> => ({ cookie: `id=${sid}` });

/** A file's metadata. `path` is a path, or `byLink(...)`. */
export async function getFile(sid: string, path: string, f?: DsmFetch): Promise<DriveFile> {
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files?${new URLSearchParams({ path })}`, {
    method: 'GET',
    headers: cookieFor(sid),
  }, fetchFor(f));
  return driveFile(verdict<RawFile>(DRIVE_API, 'get', res, await jsonBody(DRIVE_API, res)));
}

/** The most of a document the app reads back. A file larger than this is refused with a 413. */
export const DOC_MAX_BYTES = 1024 * 1024;

/**
 * A file's text, read whole. `path` is a path, or `byLink(...)`. Drive answers
 * with the bytes, or its JSON refusal in their place, as File Station's
 * download does; `bytesOrRefusal` tells them apart.
 */
export async function readFile(sid: string, path: string, f?: DsmFetch): Promise<string> {
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files/download`, {
    method: 'POST',
    headers: { ...cookieFor(sid), 'content-type': 'application/json' },
    body: JSON.stringify({ files: [path] }),
  }, fetchFor(f));
  const { bytes } = await bytesOrRefusal(DRIVE_API, 'download', res, DOC_MAX_BYTES);
  return new TextDecoder().decode(bytes);
}

/**
 * The code Drive answers for a path that names nothing: 1003, confirmed on the
 * real NAS on 2026-11-03 (`files` GET on a path that does not exist, and on a
 * Team Folder path whose case differs from the folder's). The fake answers it.
 */
export const DRIVE_NO_SUCH_FILE: ReadonlySet<number> = new Set([1003]);

export const isNoSuchFile = (err: unknown): boolean =>
  err instanceof SynologyError && DRIVE_NO_SUCH_FILE.has(err.code);

const segments = (root: string): string[] => root.split('/').filter(Boolean);

/** The Team Folder a share root lives in: its first segment. `/Planner/` is `Planner`. */
export const teamFolderName = (root: string): string => segments(root)[0] ?? '';

/** A share root as Drive addresses it: `/Planner/home` is `/team-folders/Planner/home`. */
export const teamFolderPath = (root: string): string => `/team-folders/${segments(root).join('/')}`;

/** Files in the words Drive answers a list or a search with. */
const itemsOf = (data: { items?: RawFile[] }): DriveFile[] => (data.items ?? []).map(driveFile);

/**
 * Search the files under `location` for `keyword`, each hit with the passage
 * that matched. With no `limit` Drive's own default applies.
 */
export async function search(
  sid: string, o: { keyword: string; location: string; limit?: number }, f?: DsmFetch,
): Promise<DriveFile[]> {
  const query = o.limit === undefined ? '' : `?${new URLSearchParams({ limit: String(o.limit) })}`;
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files/search${query}`, {
    method: 'POST',
    headers: { ...cookieFor(sid), 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: o.keyword, location: o.location, content_snippet: true }),
  }, fetchFor(f));
  return itemsOf(verdict<{ items?: RawFile[] }>(DRIVE_API, 'search', res, await jsonBody(DRIVE_API, res)));
}

/**
 * A folder's files, and a cursor that changes when something under it does.
 * The cursor is `${change_id}.${max_id}` read off the folder itself. Drive's
 * spec does not say which counter moves when a descendant changes, so both go
 * in and the cursor differs if either does: the check shows it.
 */
export async function listChanges(
  sid: string, folder: string, f?: DsmFetch,
): Promise<{ cursor: string; files: DriveFile[] }> {
  const dir = await getFile(sid, folder, f);
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files/list?${new URLSearchParams({ path: folder })}`, {
    method: 'POST',
    headers: cookieFor(sid),
  }, fetchFor(f));
  const files = itemsOf(verdict<{ items?: RawFile[] }>(DRIVE_API, 'list', res, await jsonBody(DRIVE_API, res)));
  return { cursor: `${dir.change_id}.${dir.max_id}`, files };
}

/** A Team Folder the signed-in user can see, and whether they may write in it. */
export interface TeamFolder { readonly name: string; readonly team_id: string; readonly canWrite: boolean }

/** The Team Folders the signed-in user can see, each with what they may do in it. */
export async function teamFolders(sid: string, f?: DsmFetch): Promise<TeamFolder[]> {
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/team-folder`, {
    method: 'GET',
    headers: cookieFor(sid),
  }, fetchFor(f));
  const data = verdict<{ items?: { name?: string; team_id?: string; capabilities?: { can_write?: boolean } }[] }>(
    DRIVE_API, 'team-folder', res, await jsonBody(DRIVE_API, res));
  return (data.items ?? []).map((i) => ({
    name: i.name ?? '', team_id: String(i.team_id ?? ''), canWrite: i.capabilities?.can_write === true,
  }));
}

/** The names of the Team Folders the signed-in user can see. */
export async function listTeamFolders(sid: string, f?: DsmFetch): Promise<string[]> {
  return (await teamFolders(sid, f)).map((t) => t.name);
}

/** Someone with access to a Team Folder, and their role there (`organizer`, `viewer`, ...). */
export interface TeamMember { readonly name: string; readonly role: string }

/** Who has access to a Team Folder, by the `team_id` that `teamFolders` gave. */
export async function teamFolderMembers(sid: string, team_id: string, f?: DsmFetch): Promise<TeamMember[]> {
  // The spec types team_id `double-quoted-string` (the only such parameter), so it travels as team_id="4"; the check's probe 3 confirms.
  const query = new URLSearchParams({ team_id: JSON.stringify(team_id) });
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/team-folder/members?${query}`, {
    method: 'GET',
    headers: cookieFor(sid),
  }, fetchFor(f));
  const data = verdict<{ items?: { name?: string; role?: string }[] }>(
    DRIVE_API, 'team-folder/members', res, await jsonBody(DRIVE_API, res));
  return (data.items ?? []).map((i) => ({ name: i.name ?? '', role: i.role ?? '' }));
}

/** The names of the folders directly under `path`; files are left out by Drive's own `dir` filter. */
export async function listFolders(sid: string, path: string, f?: DsmFetch): Promise<string[]> {
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files/list?${new URLSearchParams({ path })}`, {
    method: 'POST',
    headers: { ...cookieFor(sid), 'content-type': 'application/json' },
    body: JSON.stringify({ filter: { type: ['dir'] } }),
  }, fetchFor(f));
  return itemsOf(verdict<{ items?: RawFile[] }>(DRIVE_API, 'list', res, await jsonBody(DRIVE_API, res)))
    .map((i) => i.name);
}

/** Make one folder at `path`, whose parent must be there. A name already taken is refused, never reused. */
export async function makeFolder(sid: string, path: string, f?: DsmFetch): Promise<DriveFile> {
  const query = new URLSearchParams({ path, type: 'folder', conflict_action: 'stop' });
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files?${query}`, {
    method: 'POST',
    headers: { ...cookieFor(sid), 'content-type': 'application/json' },
    body: '{}',
  }, fetchFor(f));
  return driveFile(verdict<RawFile>(DRIVE_API, 'create', res, await jsonBody(DRIVE_API, res)));
}

/**
 * Move one file to a new parent folder, `file` by any Drive path (a `link:` one
 * here). Asynchronous on the NAS: it answers its task id at once and moves in
 * the background. A name already taken in the new parent is refused, never
 * overwritten.
 */
export async function moveFile(sid: string, file: string, toParent: string, f?: DsmFetch): Promise<string> {
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files/move`, {
    method: 'POST',
    headers: { ...cookieFor(sid), 'content-type': 'application/json' },
    body: JSON.stringify({ files: [file], to_parent_folder: toParent, conflict_action: 'stop' }),
  }, fetchFor(f));
  const data = verdict<{ async_task_id?: string }>(DRIVE_API, 'move', res, await jsonBody(DRIVE_API, res));
  return String(data.async_task_id ?? '');
}

/**
 * Drive's answer for a name already taken where a folder is made (`POST files`
 * type=folder): 1022, confirmed on the real NAS on 2026-11-03 (probe 4 of the
 * check). It is not 1003, which is "no such file" (DRIVE_NO_SUCH_FILE). A
 * `files/move` onto a taken name is NOT refused: Drive accepts it and leaves
 * both files as they were, so moves.ts finds a taken name by looking.
 */
export const DRIVE_NAME_TAKEN: ReadonlySet<number> = new Set([1022]);

export const isNameTaken = (err: unknown): boolean =>
  err instanceof SynologyError && DRIVE_NAME_TAKEN.has(err.code);

/**
 * Write `text` to the file at `path`, as a new version if it is already there.
 * The multipart body is built by hand, as `uploadFile` does: the text parts
 * first and the file part last, so the destination is known before the bytes.
 * Returns the file as it now stands, including its new `version_id`. A
 * document is a few KB of text, so it gets a JSON call's time, not a file
 * transfer's: a member waiting on a briefing does not wait two minutes on a
 * NAS that is not answering.
 */
export async function writeFile(sid: string, path: string, text: string, f?: DsmFetch): Promise<DriveFile> {
  const boundary = `----household-budget-${randomUUID()}`;
  const parts: [string, string][] = [['path', path], ['conflict_action', 'version'], ['type', 'file']];
  const head = parts.map(([k, v]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const name = path.slice(path.lastIndexOf('/') + 1);
  const fileHead = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted(name)}"\r\n`
    + 'Content-Type: text/markdown; charset=utf-8\r\n\r\n';
  const body = Buffer.concat([
    Buffer.from(head + fileHead), Buffer.from(text, 'utf8'), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}/files/upload`, {
    method: 'PUT',
    headers: { ...cookieFor(sid), 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  }, fetchFor(f), CALL_TIMEOUT_MS);
  return driveFile(verdict<RawFile>(DRIVE_API, 'upload', res, await jsonBody(DRIVE_API, res)));
}
