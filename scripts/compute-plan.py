#!/usr/bin/env python3
"""Derive the exact production cleanup ceilings from the preflight's own D1 row."""
import json, subprocess, sys, math

DB = "a8923a52-b1d4-4e0d-9bd9-aa5406face5e"
import os
def q(sql):
    body = json.dumps({"sql": sql})
    out = subprocess.run(["curl","-s","-X","POST",
        "-H",f"Authorization: Bearer {os.environ['CF_PRODUCTION_DEBUGGING_TOKEN']}",
        "-H","Content-Type: application/json","-d",body,
        f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CF_PRODUCTION_ACCOUNT_ID']}/d1/database/{DB}/query"],
        capture_output=True,text=True).stdout
    d=json.loads(out)
    if not d.get("success"): print("ERR", d.get("errors")); sys.exit(1)
    return d["result"][0]["results"]

rows = q("SELECT * FROM project_data_storage_relief_preflights")
if not rows:
    print("No preflight row yet."); sys.exit(0)
r = rows[0]
er, eb = r["eligible_rows"], r["eligible_bytes"]
print(f"plan_id        {r['plan_id']}")
print(f"project_id     {r['project_id']}")
print(f"status         {r['status']}   batches_started={r['batches_started']}  rows_examined={r['rows_examined']}")
print(f"eligible_rows  {er:,}")
print(f"eligible_bytes {eb:,}  (GROSS inline reclaim)")
print(f"sessions       {r['session_count']}")
print(f"manifest       {r['target_manifest_key']}")
print(f"manifest_sha   {r['target_manifest_sha256']}  ({r['target_manifest_bytes']} bytes)")
print(f"last_error     {r['last_error']}")
if er:
    avg = eb/er
    book = er*981
    net = eb-book
    size = q("SELECT database_size_bytes FROM project_data_storage_telemetry WHERE project_id='01KHRJGANBBWGDY1NZ0KVF0D4J'")[0]["database_size_bytes"]
    print()
    print(f"avg payload    {avg:,.0f} B/row   -> GO/NO-GO: {'GO' if avg>5000 else 'NO-GO (escalate to sharding)'} (threshold 5,000 B)")
    print(f"bookkeeping    ~{book:,} B ({book/1e6:.1f} MB) at ~981 B/row measured on staging")
    print(f"NET reclaim    ~{net:,} B ({net/1e6:.1f} MB)")
    print(f"size now       {size:,}  ->  ~{size-net:,} after  (ratio {(size-net)/1e10:.4f})")
    print(f"target 9e9     {'REACHED' if size-net<=9e9 else f'NOT reached, short by {size-net-9_000_000_000:,.0f} B'}")
    BATCH_ROWS=500
    passes = math.ceil(er/BATCH_ROWS)
    print()
    print("Ceilings to configure (derived, not typed):")
    print(f"  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS            = {er}")
    print(f"  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES           = {eb}")
    print(f"  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS   = {er*6 + r['batches_started']*4 + 1000}")
    print(f"  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS    = {passes*20000*2}   ({passes} passes x 20s x2 headroom)")
    print(f"  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY              = {r['target_manifest_key']}")
    print(f"  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256           = {r['target_manifest_sha256']}")
