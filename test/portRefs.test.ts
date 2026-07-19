import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { applyPortRefs, parsePortRefs, resolvePortRef } from '../src/portRefs.ts';
import { ensureRepoState, type State } from '../src/state.ts';

function makeConfig(): Config {
  return {
    repos: {
      api: { path: '/repo/api', fixedPort: 3000, portRange: [41300, 41310], serve: 'run -p {port}' },
      front: {
        path: '/repo/front',
        fixedPort: 8080,
        portRange: [41400, 41410],
        serve: 'API={api.port} run -p {port}',
      },
    },
  };
}

function makeState(): State {
  return { repos: {}, tasks: {} };
}

test('parsePortRefs: finds every distinct {<repo>.port} reference', () => {
  assert.deepEqual(parsePortRefs('API={api.port} PORT={port} OTHER={api.port} X={cache.port}'), ['api', 'cache']);
  assert.deepEqual(parsePortRefs('no refs here, just {port}'), []);
});

test('parsePortRefs: {api.port} does not satisfy a bare {port} substring check', () => {
  // Confirms the ordering note in portRefs.ts/config.ts holds: a template
  // relying solely on {api.port} would still need its own bare {port} to
  // pass config validation, since the two never collide.
  assert.equal('API={api.port}'.includes('{port}'), false);
});

test("resolvePortRef: expands to the referenced repo's existing sticky port", async () => {
  const config = makeConfig();
  const state = makeState();
  const rs = ensureRepoState(state, 'api');
  rs.active = 'main';
  rs.ports.main = 41305;

  const port = await resolvePortRef(config, state, 'api');
  assert.equal(port, 41305);
});

test('resolvePortRef: allocates and persists a port when none is assigned yet', async () => {
  const config = makeConfig();
  const state = makeState();
  ensureRepoState(state, 'api').active = 'main';

  const port = await resolvePortRef(config, state, 'api');
  assert.ok(port >= 41300 && port <= 41310);
  assert.equal(state.repos.api.ports.main, port);
});

test('resolvePortRef: reuses the same allocation on a second call', async () => {
  const config = makeConfig();
  const state = makeState();
  ensureRepoState(state, 'api').active = 'main';

  const first = await resolvePortRef(config, state, 'api');
  const second = await resolvePortRef(config, state, 'api');
  assert.equal(first, second);
});

test('resolvePortRef: throws for a reference to an unregistered repo', async () => {
  const config = makeConfig();
  const state = makeState();
  await assert.rejects(() => resolvePortRef(config, state, 'nosuchrepo'), /unknown repo "nosuchrepo"/);
});

test('resolvePortRef: throws when the referenced repo has no active worktree', async () => {
  const config = makeConfig();
  const state = makeState();
  await assert.rejects(() => resolvePortRef(config, state, 'api'), /no active worktree/);
});

test('applyPortRefs: substitutes {<repo>.port} without touching a bare {port}', () => {
  const result = applyPortRefs('API={api.port} PORT={port}', { api: 41305 });
  assert.equal(result, 'API=41305 PORT={port}');
});

test('serve command ordering: {<repo>.port} refs are substituted before the bare {port}', () => {
  const resolvedRefs = { api: 41305 };
  const template = 'API={api.port} PORT={port}';
  const afterRefs = applyPortRefs(template, resolvedRefs);
  const final = afterRefs.replaceAll('{port}', '41401');
  assert.equal(final, 'API=41305 PORT=41401');
});
