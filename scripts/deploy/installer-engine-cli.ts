#!/usr/bin/env -S pnpm exec tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type EngineCheckpoint,
  parseEngineCheckpoint,
  runInstallerEngine,
  writeEngineCheckpoint,
} from './installer-engine.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--state') {
    throw new Error(
      'Usage: installer-engine-cli.ts --config <private-json> --state <checkpoint-json>'
    );
  }
  const config = JSON.parse(readFileSync(resolve(args[1]), 'utf8')) as unknown;
  const path = resolve(args[3]);
  let checkpoint: EngineCheckpoint | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    checkpoint = parseEngineCheckpoint(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid checkpoint');
  }
  await runInstallerEngine(config, {
    root: process.cwd(),
    environment: process.env,
    checkpoint,
    save: (state) => writeEngineCheckpoint(path, state),
    saveResult: (result) => {
      writeFileSync(`${path}.result`, JSON.stringify(result), { mode: 0o600 });
    },
    emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
}
main().catch(() => {
  process.stderr.write(
    'Installation stopped. Inspect the last phase and repair its prerequisites before resuming.\n'
  );
  process.exitCode = 1;
});
