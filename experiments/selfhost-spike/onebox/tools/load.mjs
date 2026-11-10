// Write load generator. usage: node load.mjs BASE OP(do|d1) SECONDS CONCURRENCY ACKFILE [DO_NAMES]
// Each write uses a unique key; keys whose response was 200 are appended to ACKFILE
// (one per line) *after* the ack, so the file is the acknowledged set.
import { appendFileSync, writeFileSync } from 'node:fs';
const [base, op, secs, conc, ackFile, doNames = '4'] = process.argv.slice(2);
const end = Date.now() + Number(secs) * 1000;
writeFileSync(ackFile, '');
const lat = []; let errs = 0, n = 0; const errKinds = {};
const run = async (w) => {
  while (Date.now() < end) {
    const k = `${op}-${process.pid}-${w}-${n++}`;
    const name = `load${w % Number(doNames)}`;
    const url = op === 'do' ? `${base}/do/write?name=${name}&k=${k}` : `${base}/d1/write?k=${k}`;
    const t0 = performance.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      await r.text();
      const dt = performance.now() - t0;
      if (r.status === 200) { lat.push(dt); appendFileSync(ackFile, `${name} ${k}\n`); }
      else { errs++; errKinds[r.status] = (errKinds[r.status] || 0) + 1; }
    } catch (e) { errs++; errKinds[e.cause?.code || e.name] = (errKinds[e.cause?.code || e.name] || 0) + 1; await new Promise((r) => setTimeout(r, 200)); }
  }
};
await Promise.all(Array.from({ length: Number(conc) }, (_, i) => run(i)));
lat.sort((a, b) => a - b);
const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1) : 'n/a';
console.log(JSON.stringify({ op, conc: Number(conc), secs: Number(secs), ok: lat.length, errs, errKinds, opsPerSec: +(lat.length / Number(secs)).toFixed(1), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: lat.length ? lat.at(-1).toFixed(1) : 'n/a' }));
