import http from 'node:http'; import { readFileSync } from 'node:fs'; import { execSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
const sh = (c) => { try { return execSync(c, { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); } catch (e) { return 'ERR ' + (e.stderr?.toString().trim() || e.message).slice(0, 200); } };
const grab = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch (e) { return 'n/a'; } };
const probeUrl = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); return `HTTP ${r.status}`; } catch (e) { return `FAIL ${e.cause?.code || e.message}`; } };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.endsWith('/probe')) {
    const status = grab('/proc/self/status');
    const out = {
      id: sh('id'), capEff: status.match(/CapEff:\s*(\S+)/)?.[1], capBnd: status.match(/CapBnd:\s*(\S+)/)?.[1], noNewPrivs: status.match(/NoNewPrivs:\s*(\S+)/)?.[1],
      seccomp: status.match(/Seccomp:\s*(\S+)/)?.[1], pidsMax: grab('/sys/fs/cgroup/pids.max'), memMax: grab('/sys/fs/cgroup/memory.max'), cpuMax: grab('/sys/fs/cgroup/cpu.max'),
      pid1: grab('/proc/1/comm'), rootfsWritable: sh('touch /tmp/x && echo yes'), npmGlobalUserPrefix: sh('npm config set prefix /tmp/npmg && npm i -g --silent is-number@7 && ls /tmp/npmg/lib/node_modules'),
      gitClone: sh('git clone -q --depth 1 https://github.com/octocat/Hello-World /tmp/hw && ls /tmp/hw'),
      internet: await probeUrl('https://example.com/'),
    };
    for (const t of (u.searchParams.get('targets') || '').split(',').filter(Boolean)) out['reach ' + t] = await probeUrl(t);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out, null, 1)); return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello from container, path=${u.pathname}\n`);
});
new WebSocketServer({ server }).on('connection', (ws) => ws.on('message', (m) => ws.send('ctr-echo:' + m)));
server.listen(Number(process.env.PORT || 8080));
