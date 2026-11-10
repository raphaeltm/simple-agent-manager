# Track B working notes (reverse tunnel spike)

Machine: 2 vCPU, 3 GB RAM, Docker 29.9.3, Go 1.26.10, Node 24. celld 0.6.2, frp 0.72.0.
Tools: `scripts/install-tools.sh` (pinned + sha256-checked).

## Q1 egress (verified 2026-11-10, `celld dev`)
Worker `/probe?url=` results, all plain `fetch()`:
- http://127.0.0.1:9101/ 200, http://localhost:9101/ 200, http://127.0.0.2:9104/ 200, http://[::1]:9105/ 200
- http://172.18.0.1:9102/ (docker bridge) 200, http://172.17.0.3:9103/ (eth0, RFC1918) 200
- http://127.0.0.1:8787/ (the Worker's own listener) 200 — self-fetch works
- https://example.com/ 200; http://169.254.169.254/ connect error (no metadata service here, not a block)
- celld knobs found in `--help`: CELLD_FETCH_TIMEOUT_S (outbound fetch timeout), CELLD_HANDLER_BUDGET_S (JS handler budget); defaults not printed.
- Quirk: `celld dev` needs esbuild on PATH (or CELLD_ESBUILD); error "esbuild not found".

## Topology up (verified)
- `scripts/box-up.sh` (authz plugin :7600, frps :7000 public + loopback-only 7480 vhost / 7490 tcpmux / 17001-2 tcp / 7500 dashboard, celld dev :8787), `scripts/node-up.sh node-a|node-b` (alpine container, backend on container loopback :8444 + frpc).
- Node container 172.18.0.2: ports 22/80/443/8080/8443/8444 all closed from the box; only `127.0.0.1:8444` listens inside. Node has no inbound path.

## Q4 routing (verified)
- (a) tcp: Worker `fetch http://127.0.0.1:17001/health` → node-a, :17002 → node-b. OK.
- (b) vhost: Worker sets `Host: node-a.nodes.internal` and fetches 127.0.0.1:7480 → node-a; node-b likewise. celld lets the Worker set an arbitrary Host header (`/hostcheck` delivered `Host: evil.example` to the origin). Unknown host → frps 404.
- (c) tcpmux: works for curl (`-p -x http://127.0.0.1:7490`). From a Worker: `fetch(..., {method:'CONNECT'})` → `TypeError: Invalid HTTP method string: CONNECT`. celld does have `cloudflare:sockets` `connect()` (loopback works, raw GET to :17001 returned 200), and CONNECT to :7490 returned `200`, but pipelining the inner request in the same write was dropped. Would need a hand-written HTTP/WebSocket client over raw sockets → rejected.

## Q2 WebSocket (verified) — BLOCKER for plain passthrough, workaround found
- `fetch()` with `Upgrade: websocket` to the node returns `status 101` and a `res.webSocket` that works when the Worker accepts it (`/wsupstream`: hello received, echo OK). `new WebSocket(url)` in a Worker also works.
- Returning that response to the client — SAM's shape, both `return response` (`index.ts:723`) and `new Response(body, {status, headers, webSocket: response.webSocket})` (`index.ts:590,712`) — makes celld send `HTTP/1.1 101` with NO `Upgrade`/`Connection`/`Sec-WebSocket-Accept` headers. Clients reject it ("ws error"). Stripping the client's `Sec-WebSocket-*`/`Connection` headers on the outbound fetch does not change this.
- Works: terminate in the Worker with `WebSocketPair`, `accept()` both ends, pump `message`/`close`, AND keep the invocation alive with `ctx.waitUntil(<promise resolved on close>)`. Without `waitUntil`, the handshake completes but no upstream frame is ever delivered after the handler returns.
- With the bridge: text echo, binary echo (1000 bytes verified), server close 4001 + reason, client close 4002 + reason all propagate.

## Q2 continued (verified)
- Idle 330 s with zero traffic through the bridge, then echo OK (`evidence/q2-idle-330s-worker.txt`); direct control same.
- Server tick every 5 s for 330 s: 66 ticks, max gap 5014 ms (`evidence/q2-tick-330s-worker.txt`).
- The documented 60 s idle stream expiry did NOT hit a bridged WebSocket.
- Big frames: 1/4/16 MiB single binary messages echo intact through the bridge (99/271/818 ms vs 48/119/319 ms direct). Burst 32 MiB in 64 KiB frames: 35 MiB/s bridge vs 54 MiB/s direct (`evidence/q2-big-burst.txt`).
- NO BACKPRESSURE through the bridge: node floods 32 MiB to a client that stops reading for 20 s → direct path: node blocked 20.2 s (TCP backpressure); bridge: node finished in 129 ms, celld buffered everything. 256 MiB flood: celld worker RSS 106 MiB → 444 MiB, all delivered after the pause (`evidence/q2-slow-reader*.txt`). The documented "1 MiB WebSocket queue budget per isolate" was not enforced on this path. Risk: a fast producer (terminal `cat` of a big file) + slow browser grows box memory unboundedly.

## Q3 (verified, 2 vCPU box, everything on one host)
`evidence/q3-http-bench.txt`:
| path | 1 GiB download | 1 GiB upload (chunked, duplex half) | /health p50/p95/p99 |
|---|---|---|---|
| raw loopback (no Worker, no tunnel) | 0.91 s, 1130 MiB/s | 5.5 s | 0.7/1.0/1.2 ms |
| Worker only | 1.24 s, 828 MiB/s | 5.6 s | 2.2/4.1/7.2 ms |
| tunnel only (frps→frpc, TLS) | 4.71 s, 217 MiB/s | 8.5 s | 2.7/4.9/8.0 ms |
| Worker + tunnel (proposed) | 5.10 s, 201 MiB/s | 9.3 s | 3.0/4.4/5.6 ms |
- sha256 of the 1 GiB upload matches on every path.
- Body limit: 1 GiB + 1 byte WITH Content-Length → immediate `413 request body too large`. Chunked (no length) → celld cuts the stream after 1 GiB; the Worker's outbound fetch errors (my handler returned 502 after 8.9 s; the node had already received ~1 GiB).
- Streaming: drip 5 lines 1 s apart → each line arrives 4-13 ms after the node wrote it (no buffering).
- `celld dev` hot-reloads on any change under the project dir ("restarting the application") and drops in-flight requests (a 160 s stream was cut at 52 s when I edited wrangler.json).
- Two earlier streams (gaps 65 s / 130 s) were both cut at exactly 120.0 s; re-test below without file edits decides whether that was a cap or a reload.

## Real vm-agent as node backend (verified)
- `scripts/node-vmagent-up.sh`: vm-agent built from packages/vm-agent at main (cabd2fde8), main listener 127.0.0.1:8080, PR #2615 tunnel listener 127.0.0.1:8445 (`VM_AGENT_TUNNEL_ENABLED=true`), frpc → 8445. No Docker in the container, so provisioning fails and is skipped; HTTP serving works.
- Worker→frps→frpc→vm-agent: `GET /health` 200 `{"status":"healthy"}`; `GET /workspaces` 401 `missing Authorization header`.
- `GET /git-credential?workspaceId=node-c` via tunnel → 401 and vm-agent logs "Git credential request refused: bearerless request was relayed by a proxy" → #2615's relayed marking works unchanged for frpc.
- frpc with `loginFailExit=false` kept retrying while authz rejected it (stale lease table) and came up by itself ~15 s after authz was fixed.

## Q5 authz (verified) — `evidence/q5-authz.txt`, `box/authz/server.mjs`, `tests/authz-test.sh`
All rejections come from the Login/NewProxy plugin with a reason frpc logs:
- node-a + own valid token claiming node-b port 17002 → NewProxy reject "node-a may only bind port 17001, claimed 17002"
- … claiming node-b.nodes.internal (http vhost) → reject
- node-a token presented as nodeId=node-b → Login reject "bad token for node-b"
- proxy name not prefixed with own node id → reject; garbage token → Login reject; port 22 → reject
- node-b kept serving throughout. A second session with node-a's own valid token claiming 17001 while node-a holds it → frps "port already used" (no hijack of a live slot).
- frpc does NOT verify frps's certificate by default: frps here has no cert configured (auto self-signed) and frpc connected with no CA. Must set `transport.tls.trustedCaFile` or `useSystemCa = true` (frp source `client/connector.go`, `NewClientTLSConfigWithSystemCA`).

## Q6/Q7 and design probe (verified) — details in FINDINGS.md and evidence/q6-*, q7-*, prod-mode-*
- wss via Caddy:443 for all three nodes; frps bound 127.0.0.1:7000; no-CA frpc connects unverified; wrong CA rejected.
- Failure table: frpc 1.05 s, frps 6.7 s, celld 1.4 s, Caddy 2.4 s, 20 s partition 21.5 s (hangs). Bridged WS never closes on tunnel loss (also on prod-mode celld); celld fires neither close nor error upstream.
- Production-mode celld (`celld --bucket` on pgsty/minio + `celld deploy`): egress, WS raw/rewrap/pair results and the 120 s cap identical to `celld dev`.
- Caddy `forward_auth` → Worker `/fwdauth` returns `X-Node-Upstream`, Caddy `reverse_proxy {http.request.header.X-Node-Upstream}`: WS works, 401/404 enforced, close 1006 within ~0.2 s of frpc kill, backpressure intact (256 MiB flood blocked the node writer 31 s).
- vhost WebSocket fails: celld ignores custom Host on upgrade fetches (frps 404); `*.localhost` does not resolve in celld.
