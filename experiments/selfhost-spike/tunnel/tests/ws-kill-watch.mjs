// Open a WS with a 1 s server tick and report when/how it closes. Usage: node ws-kill-watch.mjs URL SECONDS
const [url, secs = '20'] = process.argv.slice(2); const t0 = Date.now(); let n = 0;
const ws = new WebSocket(url); ws.onopen = () => ws.send('tick:1000'); ws.onmessage = () => n++;
ws.onclose = (e) => { console.log(`${Date.now() - t0}ms close code=${e.code} clean=${e.wasClean} after ${n} msgs`); process.exit(0); };
setTimeout(() => { console.log(`${Date.now() - t0}ms still open after ${secs}s with ${n} msgs (no close delivered)`); process.exit(0); }, Number(secs) * 1000);
