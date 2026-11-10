#!/usr/bin/env node
// Throwaway: hibernatable WebSocket probe against /__spike/ws (SpikeProbeDO).
// Opens two sockets, sends messages, triggers an alarm that broadcasts via getWebSockets(tag).
const base = process.argv[2] ?? 'http://127.0.0.1:8791';
const url = base.replace(/^http/, 'ws') + '/__spike/ws';
const t0 = Date.now();
const log = (...a) => console.log(`[+${Date.now() - t0}ms]`, ...a);
const open = (n) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.onopen = () => { log(n, 'OPEN'); res(ws); };
  ws.onerror = (e) => rej(new Error(n + ' ' + (e.message ?? e.type)));
  ws.onmessage = (e) => log(n, 'MSG', String(e.data));
  ws.onclose = (e) => log(n, 'CLOSE', e.code, e.reason);
});
const a = await open('A');
const b = await open('B');
a.send('hello-from-A');
b.send('auto-ping'); // auto-response, should not wake the DO handler
await new Promise((r) => setTimeout(r, 1000));
log('arming alarm via /__spike/runtime is heavy; use alarm-status endpoint instead');
const status = await (await fetch(base + '/__spike/alarm-status')).json();
log('alarm-status', JSON.stringify(status));
// idle long enough that celld could hibernate the cell, then message again
const idle = Number(process.argv[3] ?? 15);
await new Promise((r) => setTimeout(r, idle * 1000));
log('arming alarm (via /__spike/runtime) while sockets are idle/hibernated');
const rt = await (await fetch(base + '/__spike/runtime')).json();
log('runtime probe ok=', rt.ok, 'storage bootOrder=', JSON.stringify(rt.results.find((x) => x.name === 'do.rpc.storage_features')?.detail?.bootOrder));
await new Promise((r) => setTimeout(r, 3000));
a.send('after-idle');
await new Promise((r) => setTimeout(r, 1500));
a.close(1000, 'bye'); b.close(1000, 'bye');
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
