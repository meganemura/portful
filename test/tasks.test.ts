import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStaleWiring, currentActivePort, detectWiringMismatches, taskMatchesCurrentActive } from '../src/tasks.ts';
import { ensureRepoState, type State } from '../src/state.ts';

function makeState(): State {
  return { repos: {}, tasks: {} };
}

test('currentActivePort: undefined with no active worktree or no sticky port yet, else the port', () => {
  const state = makeState();
  assert.equal(currentActivePort(state, 'api'), undefined);

  const rs = ensureRepoState(state, 'api');
  rs.active = 'main';
  assert.equal(currentActivePort(state, 'api'), undefined);

  rs.ports.main = 3101;
  assert.equal(currentActivePort(state, 'api'), 3101);
});

test('detectWiringMismatches: flags a running server whose resolvedRefs no longer match', () => {
  const state = makeState();
  const api = ensureRepoState(state, 'api');
  api.active = 'feature-x';
  api.ports['feature-x'] = 3105;

  const front = ensureRepoState(state, 'front');
  front.active = 'main';
  front.servers.main = { path: '/x', branch: 'main', port: 8101, pid: 1, resolvedRefs: { api: 3101 } };

  const mismatches = detectWiringMismatches(state, ['api', 'front']);
  assert.deepEqual(mismatches, [
    { repo: 'front', worktree: 'main', refRepo: 'api', recordedPort: 3101, currentPort: 3105 },
  ]);
});

test('detectWiringMismatches: reports the mismatch even for a repo left out of repoNames\' own switch, as long as it is included in the scan list', () => {
  // Mirrors task use scanning every configured repo, not just the task's
  // own members: "front" isn't part of whatever just changed "api", but its
  // already-running server is exactly what could be stale.
  const state = makeState();
  ensureRepoState(state, 'api').active = 'feature-x';
  ensureRepoState(state, 'api').ports['feature-x'] = 3105;
  const front = ensureRepoState(state, 'front');
  front.active = 'main';
  front.servers.main = { path: '/x', branch: 'main', port: 8101, pid: 1, resolvedRefs: { api: 3101 } };

  assert.equal(detectWiringMismatches(state, ['api']).length, 0);
  assert.equal(detectWiringMismatches(state, ['api', 'front']).length, 1);
});

test('detectWiringMismatches: no mismatch when the recorded port still matches', () => {
  const state = makeState();
  const api = ensureRepoState(state, 'api');
  api.active = 'main';
  api.ports.main = 3101;

  const front = ensureRepoState(state, 'front');
  front.active = 'main';
  front.servers.main = { path: '/x', branch: 'main', port: 8101, pid: 1, resolvedRefs: { api: 3101 } };

  assert.deepEqual(detectWiringMismatches(state, ['api', 'front']), []);
});

test('detectWiringMismatches: ignores servers with no resolvedRefs', () => {
  const state = makeState();
  const front = ensureRepoState(state, 'front');
  front.active = 'main';
  front.servers.main = { path: '/x', branch: 'main', port: 8101, pid: 1 };
  assert.deepEqual(detectWiringMismatches(state, ['front']), []);
});

test('detectWiringMismatches: ignores repos with no active worktree or no running server', () => {
  const state = makeState();
  ensureRepoState(state, 'front'); // no active set
  assert.deepEqual(detectWiringMismatches(state, ['front']), []);
});

test('computeStaleWiring: works for any server, not just a repo\'s active one, and returns [] for no/matching refs', () => {
  const state = makeState();
  const api = ensureRepoState(state, 'api');
  api.active = 'feature-x';
  api.ports['feature-x'] = 3105;

  // A non-active server entry ("main", while active is "feature-x") still
  // gets checked — computeStaleWiring doesn't care which worktree it is.
  assert.deepEqual(computeStaleWiring(state, { api: 3105 }), []);
  assert.deepEqual(computeStaleWiring(state, { api: 3101 }), [
    { repo: 'api', recordedPort: 3101, currentPort: 3105 },
  ]);
  assert.deepEqual(computeStaleWiring(state, undefined), []);
  assert.deepEqual(computeStaleWiring(state, {}), []);
});

test('taskMatchesCurrentActive: true only when every member matches the current active worktree', () => {
  const state = makeState();
  ensureRepoState(state, 'api').active = 'main';
  ensureRepoState(state, 'front').active = 'main';

  assert.equal(taskMatchesCurrentActive(state, { members: { api: 'main', front: 'main' } }), true);
  assert.equal(taskMatchesCurrentActive(state, { members: { api: 'main', front: 'other' } }), false);
  assert.equal(taskMatchesCurrentActive(state, { members: { api: 'main' } }), true);
});
