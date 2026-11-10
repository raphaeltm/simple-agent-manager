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
