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
