/**
 * The Setup checklist at the top of Settings: what a new household has still to
 * decide, in the order it is asked. Only the owner decides these, so the
 * checklist is the same for every member; what differs is whether they may act.
 *
 * Nothing here calls the NAS. A step is done by what the household's log (and
 * the deployment) already says.
 */

import { aheadOf, aheadWords, CALENDAR_GONE } from './booking.ts';
import type { Source } from './connectors.ts';
import type { RowId } from './connectors-view.ts';
import { modelSource } from './match.ts';
import type { MoveFailure } from './moves.ts';
import { PAGE_RETRY_MS } from './pages.ts';
import { householdDay, movesLeft, zoneOf } from './types.ts';
import type { Actor, State } from './types.ts';

export type SetupStep = 'folder' | 'zone' | 'calendar' | 'booking' | 'model';
export const SETUP_ORDER: readonly SetupStep[] = ['folder', 'zone', 'calendar', 'booking', 'model'];

/** `source` is where the step's value comes from, in Settings' words; null where a step has no value of that kind. */
export interface StepView { readonly id: SetupStep; readonly done: boolean; readonly source: Source | null }

/** Where the documents folder came from: the owner's choice, or the carry-over of the deployment's folder. */
export const folderSource = (state: Pick<State, 'documents'>): Source | null => {
  const folder = state.documents.folder;
  return folder === null ? null : folder.source === 'owner' ? 'saved' : 'from the deployment';
};

/** Where the household's zone comes from: its owner's choice, else the deployment's TZ, else UTC. */
export const zoneSource = (state: Pick<State, 'zone'>, env: NodeJS.ProcessEnv = process.env): Source =>
  state.zone?.trim() ? 'saved' : env['TZ']?.trim() ? 'from the deployment' : 'default';

/**
 * The checklist: the folder done only by a choice; the zone unfinished only
 * without a choice and without TZ; the calendar unfinished only with no
 * Household calendar or target; booking and the model always done, because
 * each works without being touched.
 */
export function setupSteps(state: State, env: NodeJS.ProcessEnv = process.env): { steps: StepView[]; first: SetupStep | null } {
  const zone = zoneSource(state, env);
  const steps: StepView[] = [
    { id: 'folder', done: state.documents.folder !== null, source: folderSource(state) },
    { id: 'zone', done: zone !== 'default', source: zone },
    { id: 'calendar', done: state.calendar.household !== null || state.calendar.target !== null, source: null },
    { id: 'booking', done: true, source: null },
    { id: 'model', done: true, source: modelSource(state, env) },
  ];
  return { steps, first: SETUP_ORDER.find((id) => !steps.find((s) => s.id === id)!.done) ?? null };
}

// ─── Today's notices ─────────────────────────────────────────────────────────

export type NoticeKind = 'folder' | 'not-team-folder' | 'connectors' | 'moving' | 'booking-off';

/** One quiet card above Today's thread: a reminder, never a decision, and never logged. */
export interface SetupNotice {
  readonly kind: NoticeKind;
  readonly text: string;
  readonly action?:
    | { readonly label: string; readonly open: 'settings'; readonly step: SetupStep }
    | { readonly label: string; readonly open: 'connectors'; readonly row: RowId };
}

/** `a`, `a and b`, `a, b and c`. */
const listOf = (names: readonly string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * Per load, never logged: the household's notices first, then the NAS's; none
 * for the sandbox. The owner is asked to choose a folder (or told the one
 * carried over is not a Team Folder, as this session last heard from Drive),
 * a member to ask the owner; everyone sees a move under way and what failed
 * in it; the owner sees booking turned off for a lost calendar until one is
 * chosen; an admin, the Connectors rows that need them.
 */
export function setupNotices(o: {
  state: State; who: Actor; admin: boolean; sandbox: boolean; env: NodeJS.ProcessEnv;
  teamFolder: boolean | null; failures: readonly MoveFailure[]; adminRows: readonly RowId[]; rowName: (id: RowId) => string;
}): SetupNotice[] {
  if (o.sandbox) return [];
  const { state } = o;
  const owns = state.owner === o.who;
  const notices: SetupNotice[] = [];
  const ask = `Documents are not in Drive yet. Ask ${state.owner ?? 'the owner'} to choose a folder.`;

  const home = state.documents.folder;
  if (home === null) {
    notices.push(owns
      ? {
        kind: 'folder', text: 'Your documents are not in Drive yet',
        action: { label: 'Choose a folder', open: 'settings', step: setupSteps(state, o.env).first ?? 'folder' },
      }
      : { kind: 'folder', text: ask });
  } else if (o.teamFolder === false) {
    notices.push(owns
      ? {
        kind: 'not-team-folder',
        text: `Your documents are not in Drive yet: ${home.team}/${home.folder} is not a Team Folder. `
          + 'Enable it in Synology Drive Admin Console, Team Folder, or choose another folder.',
        action: { label: 'Choose another folder', open: 'settings', step: 'folder' },
      }
      : { kind: 'not-team-folder', text: ask });
  }

  const left = movesLeft(state);
  if (home !== null && left > 0) {
    let text = `Moving ${left} ${left === 1 ? 'document' : 'documents'} to ${home.team}/${home.folder}`;
    if (o.failures.length) {
      // The soonest any of them is tried again, in the household's own time.
      const next = Math.min(...o.failures.map((f) => f.at)) + PAGE_RETRY_MS;
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: zoneOf(state), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(next);
      text += `. ${o.failures.length} could not be moved yet: ${listOf(o.failures.map((f) => f.name))}. Trying again at ${time}.`;
    }
    notices.push({ kind: 'moving', text });
  }

  if (owns && state.settings.booking?.calendarGone) {
    const counts = aheadOf(state, householdDay(state.zone));
    const ahead = aheadWords(counts);
    const verb = counts.requests + counts.stays === 1 ? 'stands' : 'stand';
    notices.push({
      kind: 'booking-off',
      // CALENDAR_GONE's own words, its full stop moved past what still stands.
      text: ahead ? `${CALENDAR_GONE.slice(0, -1)}, and ${ahead} still ${verb}.` : CALENDAR_GONE,
      action: { label: 'Choose a calendar', open: 'settings', step: 'calendar' },
    });
  }

  if (o.admin && o.adminRows.length) {
    notices.push({
      kind: 'connectors',
      text: `Set up the NAS: ${listOf(o.adminRows.map(o.rowName))}.`,
      action: { label: 'Open Connectors', open: 'connectors', row: o.adminRows[0]! },
    });
  }
  return notices;
}
