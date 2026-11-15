# Archive lifecycle timeout verification

`results.json` preserves every final file result, the earlier five-second stress failure,
phase timings, query-scaling measurements, and three discriminating mutation proofs.
`codeCommit` and `inputSha256` identify the tested source; evidence-only commits may follow.

Run the frozen harness from the repository root with installed/built workspace dependencies:

```bash
python3 tasks/evidence/2026-11-14-archive-sharding-timeout/repeat-file.py normal 1 5
python3 tasks/evidence/2026-11-14-archive-sharding-timeout/repeat-file.py loaded 1 5 0
```

Each command runs five complete files in fresh Vitest CLI processes. Repeat with starts
6, 11, 16, 21 and 26 to reach 30 per mode. Use an allowed CPU from
`os.sched_getaffinity(0)` for loaded runs; concurrent loaded batches must use distinct cores.
The harness checks all 47 cases, records actual busy-worker CPU time, bounds command
runtime, and cleans up its worker in `finally`. Outputs go to `.tmp/`; preserve existing
results before reproducing because the JSONL collector appends.

Mutations were temporary edits to the built module, restored in `finally`: remove the
unique-key predicate while retaining bind placeholders; relax the real grouped page LIMIT;
remove the canonical identity guard. The intended tests failed in each case. The subsequent
full-file green runs verify restoration. No mutation or timing instrumentation is shipped.
