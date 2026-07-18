import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { allocatePort, isPortFree } from '../src/ports.ts';

function listenOn(port: number, host = '0.0.0.0'): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

test('ports: reuses the sticky port when it is free', async () => {
  const port = await allocatePort({
    worktree: 'a',
    portRange: [40100, 40110],
    stickyPorts: { a: 40105 },
  });
  assert.equal(port, 40105);
});

test('ports: falls back to the lowest free port in range when sticky is taken', async () => {
  const blocker = await listenOn(40205);
  try {
    const port = await allocatePort({
      worktree: 'a',
      portRange: [40200, 40210],
      stickyPorts: { a: 40205 },
    });
    assert.equal(port, 40200);
  } finally {
    await closeServer(blocker);
  }
});

test('ports: skips ports sticky-assigned to sibling worktrees', async () => {
  const port = await allocatePort({
    worktree: 'a',
    portRange: [40300, 40303],
    stickyPorts: { b: 40300, c: 40301 },
  });
  assert.equal(port, 40302);
});

test('ports: throws when no free port is available in range', async () => {
  const blocker = await listenOn(40400);
  try {
    await assert.rejects(
      () =>
        allocatePort({
          worktree: 'a',
          portRange: [40400, 40400],
          stickyPorts: {},
        }),
      /No free port available/
    );
  } finally {
    await closeServer(blocker);
  }
});

test('ports: isPortFree reports false for a port held on 0.0.0.0', async () => {
  const blocker = await listenOn(40450, '0.0.0.0');
  try {
    assert.equal(await isPortFree(40450), false);
  } finally {
    await closeServer(blocker);
  }
});

test('ports: isPortFree reports true once the port is released', async () => {
  const blocker = await listenOn(40451, '0.0.0.0');
  await closeServer(blocker);
  assert.equal(await isPortFree(40451), true);
});
