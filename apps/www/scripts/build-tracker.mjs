/**
 * Compiles src/scripts/tracker.ts → public/scripts/tracker.js
 * using TypeScript's transpileModule API.
 *
 * Run as part of the build: node scripts/build-tracker.mjs
 *
 * NOTE: tracker.ts must not use top-level imports — the output is loaded
 * via a classic <script> tag, not an ES module.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpileModule } from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const source = readFileSync(resolve(root, 'src/scripts/tracker.ts'), 'utf-8');
const result = transpileModule(source, {
  compilerOptions: {
    target: 99, // ESNext
    module: 1,  // CommonJS — output is a classic script, not an ES module
    removeComments: false,
    strict: true,
  },
});

const outDir = resolve(root, 'public/scripts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'tracker.js'), result.outputText);

console.log('Compiled src/scripts/tracker.ts → public/scripts/tracker.js');
