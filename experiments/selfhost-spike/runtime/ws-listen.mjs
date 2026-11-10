#!/usr/bin/env node
// Throwaway: open the project WebSocket and print every frame for N seconds.
// usage: node ws-listen.mjs <baseUrl> <projectId> <cookie> <seconds>
const [base, projectId, cookie, secs = '20'] = process.argv.slice(2);
const url = base.replace(/^http/, 'ws') + `/api/projects/${projectId}/sessions/ws`;
const ws = new WebSocket(url, { headers: { Cookie: cookie } });
const t0 = Date.now();
const log = (...a) => console.log(`[+${Date.now() - t0}ms]`, ...a);
ws.onopen = () => { log('OPEN'); ws.send(JSON.stringify({ type: 'ping' })); };
ws.onmessage = (e) => log('MSG', String(e.data).slice(0, 400));
ws.onerror = (e) => log('ERROR', e.message ?? e.type);
ws.onclose = (e) => log('CLOSE', e.code, e.reason);
setTimeout(() => { log('done'); ws.close(); process.exit(0); }, Number(secs) * 1000);
