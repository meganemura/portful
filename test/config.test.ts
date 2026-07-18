import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

test('config: expands tilde in path and parses a valid config', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-'));
  const home = await mkdtemp(join(tmpdir(), 'wtshunt-home-'));
  try {
    await mkdir(join(configDirRoot, 'wtshunt'), { recursive: true });
    await writeFile(
      join(configDirRoot, 'wtshunt', 'config.toml'),
      [
        '[repos.b]',
        'path = "~/work/b"',
        'fixed_port = 3000',
        'port_range = [3101, 3199]',
        'serve = "bundle exec rails s -p {port}"',
        '',
      ].join('\n')
    );

    await withEnv({ XDG_CONFIG_HOME: configDirRoot, HOME: home }, async () => {
      const config = await loadConfig();
      assert.equal(config.repos.b.path, join(home, 'work', 'b'));
      assert.equal(config.repos.b.fixedPort, 3000);
      assert.deepEqual(config.repos.b.portRange, [3101, 3199]);
      assert.equal(config.repos.b.serve, 'bundle exec rails s -p {port}');
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('config: missing file throws a helpful error with sample TOML', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-missing-'));
  try {
    await withEnv({ XDG_CONFIG_HOME: configDirRoot }, async () => {
      await assert.rejects(
        () => loadConfig(),
        (err: Error) => {
          assert.match(err.message, /config\.toml/);
          assert.match(err.message, /\[repos\.b\]/);
          return true;
        }
      );
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
  }
});

test('config: missing required key throws a validation error', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-invalid-'));
  try {
    await mkdir(join(configDirRoot, 'wtshunt'), { recursive: true });
    await writeFile(
      join(configDirRoot, 'wtshunt', 'config.toml'),
      ['[repos.b]', 'path = "/tmp/b"', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join('\n')
    );

    await withEnv({ XDG_CONFIG_HOME: configDirRoot }, async () => {
      await assert.rejects(
        () => loadConfig(),
        (err: Error) => {
          assert.match(err.message, /fixed_port/);
          return true;
        }
      );
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
  }
});

test('config: serve template missing {port} throws a validation error', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-no-port-'));
  try {
    await mkdir(join(configDirRoot, 'wtshunt'), { recursive: true });
    await writeFile(
      join(configDirRoot, 'wtshunt', 'config.toml'),
      [
        '[repos.b]',
        'path = "/tmp/b"',
        'fixed_port = 3000',
        'port_range = [3101, 3199]',
        'serve = "bundle exec rails s"',
        '',
      ].join('\n')
    );

    await withEnv({ XDG_CONFIG_HOME: configDirRoot }, async () => {
      await assert.rejects(
        () => loadConfig(),
        (err: Error) => {
          assert.match(err.message, /\{port\}/);
          return true;
        }
      );
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
  }
});

test('config: a template with both {port:<repo>} and {port} passes validation', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-port-ref-'));
  try {
    await mkdir(join(configDirRoot, 'wtshunt'), { recursive: true });
    await writeFile(
      join(configDirRoot, 'wtshunt', 'config.toml'),
      [
        '[repos.api]',
        'path = "/tmp/api"',
        'fixed_port = 3000',
        'port_range = [3101, 3199]',
        'serve = "echo {port}"',
        '',
        '[repos.front]',
        'path = "/tmp/front"',
        'fixed_port = 8080',
        'port_range = [8101, 8199]',
        'serve = "API_URL=http://127.0.0.1:{port:api} PORT={port} npm run dev"',
        '',
      ].join('\n')
    );

    await withEnv({ XDG_CONFIG_HOME: configDirRoot }, async () => {
      const config = await loadConfig();
      assert.equal(config.repos.front.serve, 'API_URL=http://127.0.0.1:{port:api} PORT={port} npm run dev');
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
  }
});

test('config: a template with only {port:<repo>} and no bare {port} still fails validation', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-port-ref-only-'));
  try {
    await mkdir(join(configDirRoot, 'wtshunt'), { recursive: true });
    await writeFile(
      join(configDirRoot, 'wtshunt', 'config.toml'),
      [
        '[repos.front]',
        'path = "/tmp/front"',
        'fixed_port = 8080',
        'port_range = [8101, 8199]',
        'serve = "API_URL=http://127.0.0.1:{port:api} npm run dev"',
        '',
      ].join('\n')
    );

    await withEnv({ XDG_CONFIG_HOME: configDirRoot }, async () => {
      await assert.rejects(
        () => loadConfig(),
        (err: Error) => {
          assert.match(err.message, /\{port\}/);
          return true;
        }
      );
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
  }
});

test('config: malformed port_range throws a validation error', async () => {
  const configDirRoot = await mkdtemp(join(tmpdir(), 'wtshunt-config-invalid-range-'));
  try {
    await mkdir(join(configDirRoot, 'wtshunt'), { recursive: true });
    await writeFile(
      join(configDirRoot, 'wtshunt', 'config.toml'),
      [
        '[repos.b]',
        'path = "/tmp/b"',
        'fixed_port = 3000',
        'port_range = [3199]',
        'serve = "echo {port}"',
        '',
      ].join('\n')
    );

    await withEnv({ XDG_CONFIG_HOME: configDirRoot }, async () => {
      await assert.rejects(
        () => loadConfig(),
        (err: Error) => {
          assert.match(err.message, /port_range/);
          return true;
        }
      );
    });
  } finally {
    await rm(configDirRoot, { recursive: true, force: true });
  }
});
