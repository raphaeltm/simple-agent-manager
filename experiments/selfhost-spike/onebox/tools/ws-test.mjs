// usage: node ws-test.mjs URL CAFILE HOSTHEADER_IP   -- WebSocket echo through Caddy to a hibernatable DO socket
import WebSocket from 'ws'; import { readFileSync } from 'node:fs'; import { lookup } from 'node:dns';
const [url, ca, ip] = process.argv.slice(2);
const ws = new WebSocket(url, { ca: readFileSync(ca), lookup: (h, o, cb) => cb(null, o?.all ? [{ address: ip, family: 4 }] : ip, 4) });
const t0 = Date.now(); let n = 0;
ws.on('open', () => { console.log('open after', Date.now() - t0, 'ms'); ws.send('ping0'); });
ws.on('message', (m) => { console.log('recv', String(m)); if (++n < 3) ws.send('ping' + n); else ws.close(1000, 'done'); });
ws.on('close', (c) => { console.log('closed', c); process.exit(0); });
ws.on('error', (e) => { console.log('ERROR', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 10000);
