import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

test('ui: errors gracefully (no raw-mode/alt-screen side effects) when stdin/stdout are not a TTY', async () => {
  // execFile pipes stdin/stdout, so neither is a TTY here — this exercises
  // the same non-interactive path a cron job or CI runner would hit.
  await assert.rejects(
    () => execFileAsync(process.execPath, [binPath, 'ui'], { env: process.env }),
    (err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => {
      assert.match(String(err.stderr), /TTY/);
      assert.equal(err.code, 1);
      return true;
    }
  );
});
