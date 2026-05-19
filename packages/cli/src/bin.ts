#!/usr/bin/env node
import { run } from './commands.js';

const exitCode = await run(process.argv.slice(2), {
  env: process.env,
  fetch,
  logger: console,
  readStdin: () =>
    new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    }),
});

process.exitCode = exitCode;
