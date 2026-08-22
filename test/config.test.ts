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
      process.env[key] = env[key] as string;
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

/**
 * Writes a user-level config.json into a throwaway XDG_CONFIG_HOME and runs
 * `fn` with it in place. `extraEnv` covers the tilde-expansion cases, which
 * need HOME pointed somewhere disposable too.
 */
async function withUserConfig<T>(
  user: unknown,
  fn: (configRoot: string) => Promise<T>,
  extraEnv: Record<string, string | undefined> = {}
): Promise<T> {
  const configRoot = await mkdtemp(join(tmpdir(), 'portful-config-'));
  try {
    await mkdir(join(configRoot, 'portful'), { recursive: true });
    await writeFile(join(configRoot, 'portful', 'config.json'), JSON.stringify(user));
    return await withEnv({ XDG_CONFIG_HOME: configRoot, ...extraEnv }, () => fn(configRoot));
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
}

/** A throwaway directory standing in for a repo checkout, optionally carrying a portful.json and a package.json. */
async function makeRepoDir(slug: string, files: { portful?: unknown; packageJson?: unknown } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `portful-repo-${slug}-`));
  if (files.portful !== undefined) {
    await writeFile(join(dir, 'portful.json'), JSON.stringify(files.portful));
  }
  if (files.packageJson !== undefined) {
    await writeFile(join(dir, 'package.json'), JSON.stringify(files.packageJson));
  }
  return dir;
}

const BASE_REPO = { fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' };

async function rejectsWith(pattern: RegExp): Promise<void> {
  await assert.rejects(
    () => loadConfig(),
    (err: Error) => {
      assert.match(err.message, pattern);
      return true;
    }
  );
}

test('config: expands tilde in path and parses a valid config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'portful-home-'));
  try {
    await withUserConfig(
      { repos: { b: { path: '~/work/b', ...BASE_REPO } } },
      async () => {
        const config = await loadConfig();
        assert.equal(config.repos.b.path, join(home, 'work', 'b'));
        assert.equal(config.repos.b.fixedPort, 3000);
        assert.deepEqual(config.repos.b.portRange, [3101, 3199]);
        assert.equal(config.repos.b.serve, 'echo {port}');
      },
      { HOME: home }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('config: a missing file throws a helpful error showing a sample config', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'portful-empty-config-'));
  try {
    await withEnv({ XDG_CONFIG_HOME: configRoot }, async () => {
      await rejectsWith(/Config file not found at .*config\.json/);
      await rejectsWith(/"repos"/);
    });
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});

test('config: a missing required key throws a validation error naming every place it could be set', async () => {
  const dir = await makeRepoDir('missing-key');
  try {
    await withUserConfig({ repos: { b: { path: dir, portRange: [3101, 3199], serve: 'echo {port}' } } }, async () => {
      await rejectsWith(/"fixedPort" is required/);
      await rejectsWith(/portful\.json.*package\.json/s);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: a serve template without {port} throws a validation error', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', fixedPort: 3000, portRange: [3101, 3199], serve: 'bundle exec rails s' } } }, async () => {
    await rejectsWith(/"serve" must contain the literal placeholder "\{port\}"/);
  });
});

test('config: omitting serve is allowed, for a server that reads the injected PORT', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', fixedPort: 3000, portRange: [3101, 3199] } } }, async () => {
    const config = await loadConfig();
    assert.equal(config.repos.b.serve, undefined);
  });
});

test('config: a template carrying both {<repo>.port} and {port} passes validation', async () => {
  await withUserConfig(
    {
      repos: {
        api: { path: '/tmp/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
        front: { path: '/tmp/front', fixedPort: 8080, portRange: [8101, 8199], serve: 'API_URL=http://127.0.0.1:{api.port} PORT={port} npm run dev' },
      },
    },
    async () => {
      const config = await loadConfig();
      assert.match(config.repos.front.serve as string, /\{api\.port\}/);
    }
  );
});

test('config: a template with only {<repo>.port} and no bare {port} still fails validation', async () => {
  await withUserConfig(
    { repos: { front: { path: '/tmp/front', fixedPort: 8080, portRange: [8101, 8199], serve: 'API_URL=http://127.0.0.1:{api.port} npm run dev' } } },
    async () => {
      await rejectsWith(/"serve" must contain the literal placeholder "\{port\}"/);
    }
  );
});

test('config: picker.command parses when present', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO } }, picker: { command: 'fzf --height 40%' } }, async () => {
    const config = await loadConfig();
    assert.equal(config.picker?.command, 'fzf --height 40%');
  });
});

test('config: no picker object leaves picker undefined', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO } } }, async () => {
    const config = await loadConfig();
    assert.equal(config.picker, undefined);
  });
});

test('config: an empty picker.command fails validation', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO } }, picker: { command: '' } }, async () => {
    await rejectsWith(/picker\.command must be a non-empty string/);
  });
});

test('config: a malformed portRange throws a validation error', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', fixedPort: 3000, portRange: [3199], serve: 'echo {port}' } } }, async () => {
    await rejectsWith(/"portRange" is required and must be \[min, max\]/);
  });
});

test('config: distinct ports across repos pass validation', async () => {
  await withUserConfig(
    {
      repos: {
        api: { path: '/tmp/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
        front: { path: '/tmp/front', fixedPort: 8080, portRange: [8101, 8199], serve: 'echo {port}' },
      },
    },
    async () => {
      const config = await loadConfig();
      assert.deepEqual(Object.keys(config.repos).sort(), ['api', 'front']);
    }
  );
});

test('config: overlapping portRange between two repos throws an error naming both', async () => {
  await withUserConfig(
    {
      repos: {
        api: { path: '/tmp/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
        front: { path: '/tmp/front', fixedPort: 8080, portRange: [3150, 3250], serve: 'echo {port}' },
      },
    },
    async () => {
      await rejectsWith(/repos\.api\.portRange .* and repos\.front\.portRange .* overlap/);
    }
  );
});

test('config: a shared fixedPort between two repos throws an error naming both', async () => {
  await withUserConfig(
    {
      repos: {
        api: { path: '/tmp/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
        front: { path: '/tmp/front', fixedPort: 3000, portRange: [8101, 8199], serve: 'echo {port}' },
      },
    },
    async () => {
      await rejectsWith(/repos\.api and repos\.front both resolve to fixedPort 3000/);
    }
  );
});

test("config: a repo's fixedPort inside another repo's portRange throws an error naming both", async () => {
  await withUserConfig(
    {
      repos: {
        api: { path: '/tmp/api', fixedPort: 8150, portRange: [3101, 3199], serve: 'echo {port}' },
        front: { path: '/tmp/front', fixedPort: 8080, portRange: [8101, 8199], serve: 'echo {port}' },
      },
    },
    async () => {
      await rejectsWith(/repos\.api\.fixedPort \(8150\) falls inside repos\.front\.portRange/);
    }
  );
});

test("config: a repo's fixedPort inside its own portRange throws a validation error", async () => {
  await withUserConfig({ repos: { api: { path: '/tmp/api', fixedPort: 3150, portRange: [3101, 3199], serve: 'echo {port}' } } }, async () => {
    await rejectsWith(/falls inside its own portRange/);
  });
});

test('config: https parses cert/key/backend and expands tilde in the paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'portful-home-'));
  try {
    await writeFile(join(home, 'c.pem'), 'cert');
    await writeFile(join(home, 'k.pem'), 'key');
    await withUserConfig(
      { repos: { b: { path: '/tmp/b', ...BASE_REPO, https: { cert: '~/c.pem', key: '~/k.pem', backend: true } } } },
      async () => {
        const config = await loadConfig();
        assert.equal(config.repos.b.https?.cert, join(home, 'c.pem'));
        assert.equal(config.repos.b.https?.key, join(home, 'k.pem'));
        assert.equal(config.repos.b.https?.backend, true);
      },
      { HOME: home }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('config: https with only backend set, and no cert/key, is allowed', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO, https: { backend: true } } } }, async () => {
    const config = await loadConfig();
    assert.deepEqual(config.repos.b.https, { backend: true });
  });
});

test('config: omitting https leaves it undefined, so the proxy stays plain http', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO } } }, async () => {
    const config = await loadConfig();
    assert.equal(config.repos.b.https, undefined);
  });
});

test('config: https.cert without https.key throws an error naming the repo', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO, https: { cert: '/tmp/c.pem' } } } }, async () => {
    await rejectsWith(/repos\.b: "https\.cert" and "https\.key" must both be set/);
  });
});

test('config: https.key without https.cert throws an error naming the repo', async () => {
  await withUserConfig({ repos: { b: { path: '/tmp/b', ...BASE_REPO, https: { key: '/tmp/k.pem' } } } }, async () => {
    await rejectsWith(/repos\.b: "https\.cert" and "https\.key" must both be set/);
  });
});

test('config: an https.cert pointing at a nonexistent file throws a validation error', async () => {
  await withUserConfig(
    { repos: { b: { path: '/tmp/b', ...BASE_REPO, https: { cert: '/nonexistent/c.pem', key: '/nonexistent/k.pem' } } } },
    async () => {
      await rejectsWith(/"https\.cert" at .* does not exist or is not readable/);
    }
  );
});

test('config: a repo supplies its own settings from portful.json in the checkout', async () => {
  const dir = await makeRepoDir('repo-file', {
    portful: { fixedPort: 4000, portRange: [4101, 4199], serve: 'bin/dev -p {port}' },
  });
  try {
    await withUserConfig({ repos: { b: { path: dir } } }, async () => {
      const config = await loadConfig();
      assert.equal(config.repos.b.fixedPort, 4000);
      assert.deepEqual(config.repos.b.portRange, [4101, 4199]);
      assert.equal(config.repos.b.serve, 'bin/dev -p {port}');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: the package.json "portful" key beats portful.json, as it does in portless', async () => {
  const dir = await makeRepoDir('pkg-key', {
    portful: { fixedPort: 4000, portRange: [4101, 4199], serve: 'from-portful-json {port}' },
    packageJson: { name: 'b', portful: { serve: 'from-package-json {port}' } },
  });
  try {
    await withUserConfig({ repos: { b: { path: dir } } }, async () => {
      const config = await loadConfig();
      assert.equal(config.repos.b.serve, 'from-package-json {port}');
      // Keys the package.json entry leaves alone still come from portful.json.
      assert.equal(config.repos.b.fixedPort, 4000);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: the user-level entry beats both repo-level sources, since ports are allocated per machine', async () => {
  const dir = await makeRepoDir('user-wins', {
    portful: { fixedPort: 4000, portRange: [4101, 4199], serve: 'from-repo {port}' },
    packageJson: { name: 'b', portful: { fixedPort: 5000 } },
  });
  try {
    await withUserConfig({ repos: { b: { path: dir, fixedPort: 6000, portRange: [6101, 6199] } } }, async () => {
      const config = await loadConfig();
      assert.equal(config.repos.b.fixedPort, 6000);
      assert.deepEqual(config.repos.b.portRange, [6101, 6199]);
      assert.equal(config.repos.b.serve, 'from-repo {port}');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: a name in portful.json that disagrees with the registered name fails loading', async () => {
  const dir = await makeRepoDir('name-clash', {
    portful: { name: 'something-else', fixedPort: 4000, portRange: [4101, 4199], serve: 'echo {port}' },
  });
  try {
    await withUserConfig({ repos: { b: { path: dir } } }, async () => {
      await rejectsWith(/registered under that name .* but "name" is set to "something-else"/s);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: a malformed JSON file names the file it failed to parse', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'portful-badjson-'));
  try {
    await mkdir(join(configRoot, 'portful'), { recursive: true });
    await writeFile(join(configRoot, 'portful', 'config.json'), '{ "repos": ');
    await withEnv({ XDG_CONFIG_HOME: configRoot }, async () => {
      await rejectsWith(/Failed to parse .*config\.json/);
    });
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});
