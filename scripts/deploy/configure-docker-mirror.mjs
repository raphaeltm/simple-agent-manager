import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Preserve runner-specific daemon settings and existing fallback mirrors.
const [configPath, mirror] = process.argv.slice(2);
if (!configPath || !mirror || new URL(mirror).protocol !== 'https:') {
  throw new Error('Expected daemon configuration path and HTTPS registry mirror');
}
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Existing daemon configuration must be a JSON object');
}
const mirrors = config['registry-mirrors'] ?? [];
if (!Array.isArray(mirrors) || mirrors.some((value) => typeof value !== 'string')) {
  throw new Error('Existing registry-mirrors must be an array of strings');
}
config['registry-mirrors'] = [...new Set([mirror, ...mirrors])];
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
