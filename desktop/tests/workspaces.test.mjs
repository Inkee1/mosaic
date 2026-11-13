import test from 'node:test';
import assert from 'node:assert/strict';
import * as validation from '../../shared/validation.mjs';
const { validState } = validation;
const sets = await import('../../shared/workspaces.mjs').catch(() => ({}));
const pane = (id, url = 'https://example.com/') => ({
  id,
  title: id,
  url,
  profileId: 'work',
  kind: 'external',
  addressOpen: false,
});
const workspace = (id, name, panes = [pane('shared')]) => ({
  id,
  name,
  columns: 2,
  rows: 2,
  panes,
});
const legacy = () => ({
  version: 1,
  theme: 'light',
  profiles: [{ id: 'work', name: 'Work', note: '', color: '#123456' }],
  workspace: workspace('old-a', 'A', [pane('shared', 'https://example.com/latest')]),
  savedSets: [
    { id: 'a', savedAt: '2026-11-09T00:00:00Z', workspace: workspace('old-a', 'A') },
    { id: 'b', savedAt: '2026-11-09T00:00:00Z', workspace: workspace('old-b', 'B') },
  ],
});

test('migrating sets keeps the latest active URL and gives every pane an independent ID', () => {
  assert.equal(typeof sets.migrateSets, 'function', 'set migration must exist');
  const state = sets.migrateSets(legacy());
  assert.equal(state.activeSetId, 'a');
  assert.deepEqual(state.openSetIds, ['a']);
  assert.equal(state.workspace.panes[0].url, 'https://example.com/latest');
  assert.equal(state.savedSets[1].workspace.panes[0].url, 'https://example.com/');
  assert.equal(new Set(state.savedSets.flatMap((s) => s.workspace.panes.map((p) => p.id))).size, 2);
  assert.equal(validState(state), true);
  assert.deepEqual(sets.migrateSets(state), state);
});

test('switching and background navigation update only their own set and survive serialization', () => {
  let state = sets.migrateSets(legacy());
  const aPane = state.workspace.panes[0].id;
  state = sets.switchSet(state, 'b');
  const bPane = state.workspace.panes[0].id;
  state = sets.patchSetPane(state, aPane, 'work', { url: 'https://example.com/background' });
  state = sets.patchSetPane(state, bPane, 'work', { url: 'https://example.com/b' });
  state = sets.migrateSets(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(state.openSetIds, ['a', 'b']);
  assert.equal(state.workspace.panes[0].url, 'https://example.com/b');
  state = sets.switchSet(state, 'a');
  assert.equal(state.workspace.panes[0].url, 'https://example.com/background');
  assert.equal(validState(state), true);
});

test('closing active or background sets keeps their latest saved configuration and supports no open sets', () => {
  let state = sets.switchSet(sets.migrateSets(legacy()), 'b');
  state = sets.closeSet(state, 'a');
  assert.equal(state.activeSetId, 'b');
  assert.deepEqual(state.openSetIds, ['b']);
  state = sets.closeSet(state, 'b');
  assert.equal(state.activeSetId, null);
  assert.deepEqual(state.openSetIds, []);
  assert.equal(state.workspace.panes.length, 0);
  assert.equal(state.savedSets.length, 2);
  assert.equal(validState(state), true);
  state = sets.switchSet(sets.migrateSets(JSON.parse(JSON.stringify(state))), 'a');
  assert.equal(state.workspace.panes[0].url, 'https://example.com/latest');
});

test('active edits synchronize to their set without changing other sets', () => {
  const state = sets.migrateSets(legacy());
  const edited = sets.syncActiveSet({
    ...state,
    workspace: { ...state.workspace, name: 'Renamed', columns: 3, panes: [] },
  });
  assert.equal(edited.savedSets.find((s) => s.id === 'a').workspace.columns, 3);
  assert.equal(edited.savedSets.find((s) => s.id === 'b').workspace.panes.length, 1);
  assert.equal(validState(edited), true);
});

test('opening beyond the live pane limit fails without modifying any saved set', () => {
  let state = sets.migrateSets(legacy());
  for (let i = 0; i < 4; i++)
    state = sets.createSet(
      state,
      workspace(
        'extra-' + i,
        'Extra ' + i,
        Array.from({ length: 31 }, (_, j) => pane('extra-' + i + '-' + j)),
      ),
    );
  // A is still open: 1 + 4*31 = 125. Add a saved, closed 4-pane set.
  state.savedSets.push({
    id: 'overflow',
    savedAt: new Date().toISOString(),
    workspace: workspace(
      'overflow',
      'Overflow',
      Array.from({ length: 4 }, (_, j) => pane('overflow-' + j)),
    ),
  });
  const before = JSON.stringify(state);
  assert.throws(() => sets.switchSet(state, 'overflow'), /128/);
  assert.equal(JSON.stringify(state), before);
});

test('validation rejects unknown open sets, missing active sets, duplicate pane IDs and stale active copies', () => {
  const state = sets.migrateSets(legacy());
  assert.equal(validState({ ...state, openSetIds: ['missing'] }), false);
  assert.equal(validState({ ...state, activeSetId: 'b' }), false);
  const duplicated = structuredClone(state);
  duplicated.savedSets[1].workspace.panes[0].id = duplicated.workspace.panes[0].id;
  assert.equal(validState(duplicated), false);
  assert.equal(validState({ ...state, workspace: { ...state.workspace, name: 'Stale' } }), false);
});

test('native synchronization accepts several sets but rejects duplicate IDs and the total limit', () => {
  assert.equal(typeof validation.validPaneDescriptors, 'function');
  const profiles = legacy().profiles;
  const panes = Array.from({ length: 65 }, (_, i) => pane('native-' + i));
  assert.equal(validation.validPaneDescriptors(panes, profiles), true);
  assert.equal(validation.validPaneDescriptors([...panes, panes[0]], profiles), false);
  assert.equal(
    validation.validPaneDescriptors(
      Array.from({ length: 129 }, (_, i) => pane('native-' + i)),
      profiles,
    ),
    false,
  );
});

test('migration preserves all 200 legacy snapshots plus separate current and previous work', () => {
  const previous = legacy();
  previous.savedSets = Array.from({ length: 200 }, (_, i) => ({
    id: 'saved-' + i,
    savedAt: '2026-11-09T00:00:00Z',
    workspace: workspace('old-' + i, 'Saved ' + i),
  }));
  previous.workspace = workspace('current-only', 'Current only');
  previous.previousWorkspace = workspace('previous-only', 'Previous only');
  const migrated = sets.migrateSets(previous);
  assert.equal(migrated.savedSets.length, 202);
  assert.equal(migrated.workspace.name, 'Current only');
  assert.ok(migrated.savedSets.some((set) => set.workspace.name === 'Previous only'));
  assert.equal(validState(migrated), true);
});

test('events from a replaced profile cannot overwrite a set current location', () => {
  const state = sets.migrateSets(legacy());
  const updated = sets.patchSetPane(state, state.workspace.panes[0].id, 'old-profile', {
    url: 'https://wrong.example/',
  });
  assert.equal(updated, state);
});
