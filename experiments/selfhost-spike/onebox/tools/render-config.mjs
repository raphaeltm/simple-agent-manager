// usage: node render-config.mjs TEMPLATE.jsonc SECRETS.env OUT.json [KEY=VALUE ...]
// Merges per-deployment vars (KEY=VALUE args) and secrets (dotenv file) into
// the template's "vars". celld deploy reads no .dev.vars, so this is the only
// production path for Worker secrets in celld 0.6.x.
import { readFileSync, writeFileSync } from 'node:fs';
const [tpl, secretsFile, out, ...kv] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(tpl, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
cfg.vars ??= {};
for (const a of kv) { const i = a.indexOf('='); cfg.vars[a.slice(0, i)] = a.slice(i + 1); }
if (secretsFile && secretsFile !== '-') {
  const text = readFileSync(secretsFile, 'utf8');
  // Minimal dotenv: NAME=value, NAME="multi\nline". No interpolation.
  const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\n#]*))/gm;
  let m; let n = 0;
  while ((m = re.exec(text))) { cfg.vars[m[1]] = m[2] !== undefined ? m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"') : (m[3] ?? m[4].trim()); n++; }
  console.error(`merged ${n} secret(s) from ${secretsFile}`);
}
writeFileSync(out, JSON.stringify(cfg, null, 2), { mode: 0o600 });
