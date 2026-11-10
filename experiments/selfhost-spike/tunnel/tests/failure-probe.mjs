// Q7 probe: for DURATION s, concurrently (1) GET /health every 100 ms, (2) keep a bridged WebSocket
// with a 1 s server tick (reconnecting on close), (3) keep a streaming GET (/drip, 500 ms lines),
// reconnecting on end. Logs every transition with ms since start. Usage: node failure-probe.mjs BASE DURATION
const [base, dur = '60'] = process.argv.slice(2);
const t0 = Date.now(); const T = () => String(Date.now() - t0).padStart(6) + 'ms';
const end = t0 + Number(dur) * 1000; const log = (...a) => console.log(T(), ...a);
let lastHealth = null, healthFailSince = null;
(async () => { while (Date.now() < end) {
  let st; try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); st = r.status; await r.text(); } catch (e) { st = 'ERR:' + (e.cause?.code || e.name); }
  if (st !== lastHealth) { log(`health ${lastHealth} -> ${st}` + (st === 200 && healthFailSince ? ` (outage ${Date.now() - healthFailSince} ms)` : '')); if (st !== 200 && healthFailSince === null) healthFailSince = Date.now(); if (st === 200) healthFailSince = null; lastHealth = st; }
  await new Promise((r) => setTimeout(r, 100)); } })();
(async () => { while (Date.now() < end) {
  const opened = Date.now(); let ticks = 0;
  const res = await new Promise((ok) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws?_ws=pair&_wait=1');
    ws.onopen = () => ws.send('tick:1000'); ws.onmessage = () => ticks++;
    ws.onclose = (e) => ok(`close code=${e.code} reason=${JSON.stringify(e.reason)} clean=${e.wasClean}`); ws.onerror = () => {};
    setTimeout(() => { try { ws.close(1000, 'probe-end'); } catch {} }, Math.max(0, end - Date.now()));
  });
  log(`ws ended after ${Date.now() - opened} ms, ${ticks} msgs: ${res}`); await new Promise((r) => setTimeout(r, 500)); } })();
(async () => { while (Date.now() < end) {
  const opened = Date.now(); let lines = 0, why = 'complete';
  try { const r = await fetch(`${base}/drip?count=1000&interval=500`, { signal: AbortSignal.timeout(Math.max(1, end - Date.now())) });
    if (r.status !== 200) why = `status ${r.status}`; else { const rd = r.body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; lines += new TextDecoder().decode(value).split('\n').length - 1; } }
  } catch (e) { why = 'ERR:' + (e.cause?.code || e.name || e.message); }
  if (Date.now() < end) log(`stream ended after ${Date.now() - opened} ms, ${lines} lines: ${why}`); await new Promise((r) => setTimeout(r, 500)); } })();
setTimeout(() => { log('probe done'); process.exit(0); }, Number(dur) * 1000 + 300);
