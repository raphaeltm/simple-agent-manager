#!/usr/bin/env node
import { run } from './commands.js';

const exitCode = await run(process.argv.slice(2), {
  env: process.env,
  fetch,
  logger: console,
});

process.exitCode = exitCode;
