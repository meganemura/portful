import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { delimiter, join } from 'node:path';
import { loadConfig, type Config } from './config.ts';

export interface PickerOption {
  /** Tab-separated display columns shown to the picker and the numbered prompt alike; columns[0] doubles as this option's value. */
  columns: string[];
}

export type PickerKind = 'config' | 'peco' | 'fzf' | 'numbered';

export interface ResolvePickerOptions {
  config?: Config;
  /** Overrides which binary name is PATH-checked for peco — for tests only. */
  pecoBin?: string;
  /** Overrides which binary name is PATH-checked for fzf — for tests only. */
  fzfBin?: string;
}

async function isBinAvailable(bin: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function isPecoAvailable(): Promise<boolean> {
  return isBinAvailable('peco');
}

/**
 * Picks which picker `pickOne` uses: an explicit `[picker] command` in
 * config always wins, then peco (preserving the pre-existing default so
 * nothing changes for users who already rely on it), then fzf, then the
 * plain numbered prompt.
 */
export async function resolvePickerKind(options: ResolvePickerOptions = {}): Promise<PickerKind> {
  if (options.config?.picker?.command) {
    return 'config';
  }
  if (await isBinAvailable(options.pecoBin ?? 'peco')) {
    return 'peco';
  }
  if (await isBinAvailable(options.fzfBin ?? 'fzf')) {
    return 'fzf';
  }
  return 'numbered';
}

function toLine(option: PickerOption): string {
  return option.columns.join('\t');
}

/**
 * Runs `command` (with `args`) as an external picker: every candidate line
 * is written to its stdin, and the selected line is read back from its
 * stdout. A non-zero exit or empty output is treated as a cancellation —
 * this is the protocol peco, fzf (which exits 130 on Esc), and any
 * config-driven `[picker] command` all share.
 */
function runExternalPicker(command: string, args: string[], lines: string[]): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        resolvePromise(undefined);
        return;
      }
      resolvePromise(output.trim());
    });
    // A picker that exits without ever reading stdin (e.g. a cancel-only
    // command like `false`) would otherwise surface as an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}

async function pickWithExternal(
  command: string,
  args: string[],
  options: PickerOption[]
): Promise<string | undefined> {
  const selectedLine = await runExternalPicker(command, args, options.map(toLine));
  if (!selectedLine) {
    return undefined;
  }
  return selectedLine.split('\t')[0];
}

async function pickByNumber(options: PickerOption[], prompt: string): Promise<string | undefined> {
  options.forEach((option, i) => {
    console.log(`${i + 1}) ${toLine(option)}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(prompt);
  } finally {
    rl.close();
  }

  const index = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= options.length) {
    return undefined;
  }
  return options[index].columns[0];
}

/** Picks one option's value (columns[0]) via the resolved picker (config command, peco, or fzf), else a numbered prompt. */
export async function pickOne(options: PickerOption[], prompt = 'Select: '): Promise<string | undefined> {
  if (options.length === 0) {
    return undefined;
  }

  let config: Config | undefined;
  try {
    config = await loadConfig();
  } catch {
    // Callers already load config themselves before reaching pickOne, so
    // this only matters in isolation (e.g. tests calling pickOne
    // directly); fall back to auto-detection with no [picker] override.
  }

  const kind = await resolvePickerKind({ config });

  switch (kind) {
    case 'config':
      return pickWithExternal('sh', ['-c', config!.picker!.command!], options);
    case 'peco':
      return pickWithExternal('peco', [], options);
    case 'fzf':
      return pickWithExternal('fzf', [], options);
    case 'numbered':
      return pickByNumber(options, prompt);
  }
}
