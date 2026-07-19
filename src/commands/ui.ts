import readline from 'node:readline';
import { loadConfig } from '../config.ts';
import { resolveMux } from '../mux.ts';
import { buildOverview, type Overview } from '../overview.ts';
import { buildRows, moveSelection, type UiRow } from '../ui/model.ts';
import { keyToAction, executeAction, pendingMessage, invalidKeyHint, type ActionDeps } from '../ui/actions.ts';
import {
  renderLines,
  CLEAR_AND_HOME,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  type UiMessage,
} from '../ui/render.ts';
import { setActiveWorktree } from './use.ts';
import { applyTask } from './task.ts';
import { stopServer } from './stop.ts';

const REFRESH_INTERVAL_MS = 2000;

interface ReadlineKey {
  name?: string;
  ctrl?: boolean;
}

/** Reduces a readline keypress event down to the logical key `keyToAction` dispatches on. */
function normalizeKey(str: string | undefined, key: ReadlineKey | undefined): string {
  if (key?.ctrl && key.name === 'c') {
    return 'ctrl-c';
  }
  if (key?.name === 'return') {
    return 'return';
  }
  if (key?.name) {
    return key.name;
  }
  return str ?? '';
}

export async function uiCommand(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('wtshunt ui requires an interactive terminal (TTY).');
  }

  const config = await loadConfig();
  const mux = resolveMux(config);
  const deps: ActionDeps = { setActiveWorktree, applyTask, stopServer, mux };

  let overview: Overview = await buildOverview(config);
  let rows: UiRow[] = buildRows(overview);
  let selected = 0;
  let message: UiMessage = { text: '', isError: false };

  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  const draw = () => {
    process.stdout.write(CLEAR_AND_HOME + renderLines(rows, selected, message).join('\r\n'));
  };

  const refresh = async () => {
    try {
      overview = await buildOverview(config);
      rows = buildRows(overview);
      if (selected > rows.length - 1) {
        selected = Math.max(0, rows.length - 1);
      }
    } catch (err) {
      message = { text: err instanceof Error ? err.message : String(err), isError: true };
    }
    draw();
  };

  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  draw();
  const interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

  const onResize = () => draw();
  process.stdout.on('resize', onResize);

  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    clearInterval(interval);
    process.stdout.off('resize', onResize);
    restore();
  };

  process.on('exit', restore);

  await new Promise<void>((resolveDone) => {
    const onSigint = () => {
      finish();
      resolveDone();
    };
    process.on('SIGINT', onSigint);

    process.stdin.on('keypress', (str: string, key: ReadlineKey | undefined) => {
      if (done) {
        return;
      }

      const logicalKey = normalizeKey(str, key);

      if (logicalKey === 'up' || logicalKey === 'k') {
        selected = moveSelection(rows, selected, -1);
        draw();
        return;
      }
      if (logicalKey === 'down' || logicalKey === 'j') {
        selected = moveSelection(rows, selected, 1);
        draw();
        return;
      }

      const action = keyToAction(rows[selected], logicalKey);
      if (action.type === 'quit') {
        finish();
        resolveDone();
        return;
      }
      if (action.type === 'none') {
        // Known action key, wrong row kind (e.g. `s` on a task row): say so.
        // A key with no binding at all stays silently ignored, as before.
        const hint = invalidKeyHint(rows[selected], logicalKey);
        if (hint) {
          message = { text: hint, isError: false };
          draw();
        }
        return;
      }

      // Show the "in progress" message right away — `stop`/`restart` poll
      // for up to a couple seconds, and the screen shouldn't sit frozen
      // with no acknowledgement for the entire wait.
      message = { text: pendingMessage(action), isError: false };
      draw();

      void (async () => {
        try {
          message = { text: await executeAction(action, overview, deps), isError: false };
        } catch (err) {
          message = { text: err instanceof Error ? err.message : String(err), isError: true };
        }
        if (!done) {
          await refresh();
        }
      })();
    });
  });
}
