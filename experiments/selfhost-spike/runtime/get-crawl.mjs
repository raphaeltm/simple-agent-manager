#!/usr/bin/env node
// Throwaway: GET every /api path the web client references (apps/web/src/lib/api*), with
// ${...} placeholders replaced by seeded ids, and report status codes. A 5xx is a runtime
// failure worth reading in the node log; 4xx is usually "fake id / missing feature".
// usage: node get-crawl.mjs <base> <cookie> <projectId> <sessionId> > crawl.json
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [base, cookie, projectId, sessionId] = process.argv.slice(2);
const repo = resolve(new URL('.', import.meta.url).pathname, '../../..');
const roots = [join(repo, 'apps/web/src/lib/api'), join(repo, 'apps/web/src/lib/project-events-api.ts')];
const files = [];
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : files.push(p));
roots.forEach(walk);

const paths = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/[`'](\/api\/[^`'\s]*)[`']/g)) paths.add(m[1]);
}
const sub = (p) =>
  p
    .replace(/\$\{[^}]*project[^}]*\}/gi, projectId)
    .replace(/\$\{[^}]*session[^}]*\}/gi, sessionId)
    .replace(/\$\{[^}]*user[^}]*\}/gi, 'spike-user-1')
    .replace(/\$\{[^}]*\}/g, 'x')
    .replace(/:projectId/g, projectId)
    .replace(/:sessionId/g, sessionId)
    .replace(/:[a-zA-Z]+/g, 'x')
    .split('?')[0];

const results = [];
for (const raw of [...paths].sort()) {
  const url = base + sub(raw);
  const t0 = Date.now();
  let status = 0;
  let body = '';
  try {
    const res = await fetch(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(20000) });
    status = res.status;
    body = (await res.text()).slice(0, 160);
  } catch (e) {
    body = 'FETCH ' + e.message;
  }
  results.push({ raw, url: url.slice(base.length), status, ms: Date.now() - t0, body: status >= 500 || status === 0 ? body : undefined });
}
const by = {};
for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
console.log(JSON.stringify({ total: results.length, byStatus: by, failures: results.filter((r) => r.status >= 500 || r.status === 0), all: results }, null, 1));
