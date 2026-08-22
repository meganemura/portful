import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, formatRoutes, type ListRoute } from '../src/commands/list.ts';
import type { Overview, OverviewRepo } from '../src/overview.ts';

function repo(overrides: Partial<OverviewRepo> = {}): OverviewRepo {
  return {
    name: 'api',
    path: '/tmp/api',
    fixedPort: 3000,
    tls: false,
    worktrees: [],
    ports: {},
    servers: {},
    ...overrides,
  };
}

function overview(repos: OverviewRepo[]): Overview {
  return { repos, tasks: [] };
}

test('buildRoutes: reports the address, the active worktree, and its running port', () => {
  const routes = buildRoutes(
    overview([
      repo({
        active: 'feature-x',
        servers: { 'feature-x': { branch: 'feature-x', port: 3101, pid: 111 } },
        proxy: { pid: 222, port: 3000 },
      }),
    ])
  );

  assert.deepEqual(routes, [
    { name: 'api', address: 'http://127.0.0.1:3000', target: 'feature-x', targetPort: 3101, proxyRunning: true },
  ]);
});

test('buildRoutes: an active worktree with no server reports the target without a port', () => {
  const routes = buildRoutes(overview([repo({ active: 'feature-y' })]));
  assert.deepEqual(routes, [
    { name: 'api', address: 'http://127.0.0.1:3000', target: 'feature-y', proxyRunning: false },
  ]);
});

test('buildRoutes: no active worktree leaves the target out entirely', () => {
  const routes = buildRoutes(overview([repo()]));
  assert.deepEqual(routes, [{ name: 'api', address: 'http://127.0.0.1:3000', proxyRunning: false }]);
});

test('buildRoutes: a repo that terminates TLS advertises an https address', () => {
  const routes = buildRoutes(overview([repo({ tls: true, fixedPort: 8443 })]));
  assert.equal(routes[0].address, 'https://127.0.0.1:8443');
});

test('formatRoutes: columns line up across rows of differing width', () => {
  const routes: ListRoute[] = [
    { name: 'api', address: 'http://127.0.0.1:3000', target: 'feature-x', targetPort: 3101, proxyRunning: true },
    { name: 'front-office', address: 'http://127.0.0.1:8080', proxyRunning: false },
  ];

  const lines = formatRoutes(routes);

  assert.equal(lines[0].indexOf('ADDRESS'), lines[1].indexOf('http://127.0.0.1:3000'));
  assert.equal(lines[0].indexOf('ADDRESS'), lines[2].indexOf('http://127.0.0.1:8080'));
  assert.match(lines[1], /feature-x :3101\s+running$/);
  assert.match(lines[2], /\(no active worktree\)\s+stopped$/);
});

test('formatRoutes: an empty config says so rather than printing a bare header', () => {
  assert.deepEqual(formatRoutes([]), ['No repos configured.']);
});
