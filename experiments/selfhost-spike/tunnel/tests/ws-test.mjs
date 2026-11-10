// WebSocket passthrough checks. Usage: node ws-test.mjs <ws-url> <mode> [arg]
//   basic          text + binary echo, server close code, client close code
//   idle <sec>     open, stay silent <sec>, then echo once (does an idle socket survive?)
//   tick <sec>     server pushes every 5 s for <sec>; reports gaps and survival
//   big <MiB>      one binary message of <MiB>, echoed back, verified
//   burst <MiB>    many 64 KiB binary messages totalling <MiB>, echoed, throughput
const [url, mode = 'basic', arg] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString(), ...a);
function open(u = url) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(u); ws.binaryType = 'arraybuffer';
    const q = []; let waiter = null;
    ws.onmessage = (e) => { if (waiter) { const w = waiter; waiter = null; w(e.data); } else q.push(e.data); };
    ws.next = (ms = 15000) => q.length ? Promise.resolve(q.shift()) : new Promise((res, rej) => { waiter = res; setTimeout(() => rej(new Error('timeout waiting for message')), ms); });
    ws.closed = new Promise((res) => (ws.onclose = (e) => res({ code: e.code, reason: e.reason, wasClean: e.wasClean })));
    ws.onopen = () => ok(ws); ws.onerror = (e) => fail(new Error('ws error ' + (e.message || '')));
  });
}
const t0 = Date.now();
try {
  if (mode === 'basic') {
    let ws = await open(); log('open', await ws.next());
    ws.send('hello text'); log('text echo ok =', (await ws.next()) === 'hello text');
    const bin = new Uint8Array(1000).map((_, i) => (i * 7) & 255); ws.send(bin);
    const back = new Uint8Array(await ws.next()); log('binary echo ok =', back.length === 1000 && back.every((v, i) => v === bin[i]));
    ws.send('close:4001:server-chose-4001'); log('server-initiated close ->', JSON.stringify(await ws.closed));
    ws = await open(); await ws.next(); ws.close(4002, 'client-chose-4002'); log('client-initiated close ->', JSON.stringify(await ws.closed));
  } else if (mode === 'idle') {
    const ws = await open(); await ws.next(); log(`open; idling ${arg}s`);
    const early = await Promise.race([ws.closed, new Promise((r) => setTimeout(() => r(null), Number(arg) * 1000))]);
    if (early) log('CLOSED during idle after', (Date.now() - t0) / 1000, 's', JSON.stringify(early));
    else { ws.send('after-idle'); try { log('echo after idle ok =', (await ws.next(10000)) === 'after-idle'); } catch (e) { log('echo after idle FAILED', e.message); } ws.close(1000); }
  } else if (mode === 'tick') {
    const ws = await open(); await ws.next(); ws.send('tick:5000'); let n = 0, maxGap = 0, last = Date.now();
    const end = Date.now() + Number(arg) * 1000;
    while (Date.now() < end) {
      try { await ws.next(15000); n++; maxGap = Math.max(maxGap, Date.now() - last); last = Date.now(); }
      catch (e) { log('tick stream broke after', (Date.now() - t0) / 1000, 's:', e.message, JSON.stringify(await Promise.race([ws.closed, Promise.resolve('still-open')]))); process.exit(1); }
    }
    log(`held ${arg}s, ticks=${n}, maxGapMs=${maxGap}`); ws.close(1000);
  } else if (mode === 'big') {
    const ws = await open(); await ws.next(); const size = Number(arg) * 1024 * 1024; const b = new Uint8Array(size).map((_, i) => i & 255);
    const s = Date.now(); ws.send(b); const back = new Uint8Array(await ws.next(60000));
    log(`big ${arg} MiB echo ok =`, back.length === size && back[size - 1] === ((size - 1) & 255), `in ${Date.now() - s} ms`);
    ws.close(1000); log('close', JSON.stringify(await ws.closed));
  } else if (mode === 'burst') {
    const ws = await open(); await ws.next(); const chunk = new Uint8Array(64 * 1024); const count = Number(arg) * 16;
    const s = Date.now(); for (let i = 0; i < count; i++) ws.send(chunk);
    let got = 0; for (let i = 0; i < count; i++) got += (await ws.next(60000)).byteLength;
    const ms = Date.now() - s; log(`burst ${arg} MiB in 64 KiB frames: echoed ${got} bytes in ${ms} ms = ${(got / 1048576 / (ms / 1000)).toFixed(1)} MiB/s`);
    ws.close(1000);
  }
} catch (e) { log('FAILED', e.message); process.exit(1); }
