# Local workerd chat-ingest cost samples

These numeric diagnostic samples are not production forecasts or exact timing contracts. They contain statement templates and counters, without bound values or message content.

`part1-before.json` was measured on Part1 head245ed7427eb9d84bbf0ec6eef2b8375fe339692f. Other files compare the Part2 bounded-publication candidate before and after removing text-row seals as a bookkeeping-flush trigger. The interval is30 seconds. Matched windows use production migrations/indexes and10,000 historical messages,120 actual RPC batches at2 second intervals, real due alarms, and actual end-of-turn flush/summary publication. The original mixed50 sample instead reproduces the historical2100-message/42-batch profile without lifecycle extras. SQL+native writes are counted; unmeasured reads are null. D1 counts are separate.

The new thinking/tool JSON fixture comes from actual ACP ExtractMessages→Reporter durable outbox→HTTP transport, verified by thinking_tool_fixture_test.go. Its1000 rows comprise5% user,35% thinking,40% assistant and20% tool; two calls per20-event cycle each emit initiation and completion. These synthetic proportions exercise frequent role boundaries and moderate4-message/2-second batches; they are not an observed production distribution. Existing mixed traffic uses the original reporter fixture. Steady windows contain one assistant chunk per batch.

| Shape | Before OFF / ON | With seal folds OFF / ON | Without seal folds OFF / ON |
| --- | ---: | ---: | ---: |
|Steady|1205 /965|634 /394|634 /394|
|Mixed4|2309 /1253|1738 /996|1738 /682|
|Thinking/tool4|2309 /1901|1738 /2073|1738 /1330|
|Original mixed50|6615 /1596|6449 /1725|6449 /1430|

`seal-fold-attribution.json` itemizes the original mixed50 ON increase:84 pending-receipt writes+44 queue writes+1 do_meta=129. The168 canonical fold writes replace168 previous counter writes;42 workspace writes remain unchanged. An earlier non-frozen sample increased131, differing by2 scheduler writes.

All eight no-regression bounds passed without seal folds, but original mixed50 savings are only2.5% OFF/10.4% ON, below the requested approximately20% across shapes. Coordinator event bb957c71-8f74-4fba-84bd-9c523ef32215 pauses Part2 pending production rows-per-batch/role counters from PR2773. No Part2 PR/deployment or further implementation is authorized until that decision. Behavioral/full quality/release gates are incomplete; existing explicit-seal expectations require reconciliation if work resumes.
