// api/test/folder.ts
//
// Not a test file: the one line a fixture needs so that its household has
// chosen where documents live, as the owner does in Settings. The default is
// the folder PLANNER_ROOT=/Planner used to give a household (`Planner`, then
// the household's id), so a fixture's paths stay what they were.
import { basename, dirname, resolve } from 'node:path';

import type { Store } from '../src/store.ts';
import type { DocumentsFolder } from '../src/types.ts';

/** The household's id when the store is one of the server's households (HOUSEHOLDS_DIR/<id>/events.jsonl), else h1. */
function householdOf(store: Store): string {
  const dir = process.env['HOUSEHOLDS_DIR'];
  const home = dirname(store.path);
  return dir && dirname(home) === resolve(dir) ? basename(home) : 'h1';
}

/** documents.folder, as the owner; by default Planner and the household's id. */
export async function chooseFolderIn(store: Store, c?: DocumentsFolder): Promise<void> {
  const { team, folder } = c ?? { team: 'Planner', folder: householdOf(store) };
  const owner = store.state.owner;
  if (!owner) throw new Error('the household has no owner to choose its folder');
  await store.append(owner, { op: 'documents.folder', team, folder, source: 'owner' });
}
