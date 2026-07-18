import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { delimiter, join } from 'node:path';

export interface PickerOption {
  /** Tab-separated display columns shown to peco and the numbered prompt alike; columns[0] doubles as this option's value. */
  columns: string[];
}

export async function isPecoAvailable(): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      await access(join(dir, 'peco'), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function toLine(option: PickerOption): string {
  return option.columns.join('\t');
}

function runPeco(lines: string[]): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('peco', [], { stdio: ['pipe', 'pipe', 'inherit'] });
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
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}

async function pickWithPeco(options: PickerOption[]): Promise<string | undefined> {
  const selectedLine = await runPeco(options.map(toLine));
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

/** Picks one option's value (columns[0]) via peco if available, else a numbered prompt. */
export async function pickOne(options: PickerOption[], prompt = 'Select: '): Promise<string | undefined> {
  if (options.length === 0) {
    return undefined;
  }
  return (await isPecoAvailable()) ? await pickWithPeco(options) : await pickByNumber(options, prompt);
}
