# ProjectData diagnostics

The existing `project_data.row_usage` log reports approximate per-operation SQL reads/writes and alarm writes. `alarmWrites` is already included in `rowsWritten`. Counters live only in the Durable Object instance and can be lost on eviction; requested elapsed time is not logged coverage.

`messageIngest` in the same log window explains batch persistence without logging message content, metadata, IDs or source identities:

| Field                                                | Meaning                                                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batches`                                            | Batch persistence transactions that returned successfully, including duplicate-only batches                                                                            |
| `received`, `accepted`, `inserted`                   | Transport chunks, newly accepted logical chunks, and physical inserts respectively, by fixed role (`user`, `assistant`, `thinking`, `tool`, `plan`, `system`, `other`) |
| `eligible`                                           | Accepted assistant chunks with null stored tool metadata, regardless of whether the merge gate is enabled                                                              |
| `coalesced`                                          | Logical chunks absorbed into an earlier canonical row, including merges within the same batch                                                                          |
| `appendStatements`                                   | Successful SQL updates to an existing canonical row; multiple chunks in one batch may share one update                                                                 |
| `duplicates`                                         | Chunks rejected as duplicates by the existing persistence logic                                                                                                        |
| `mergeReadyBatches`                                  | Batches passing setting, socket, source, sequence and receipt prerequisites (may contain no eligible chunks)                                                           |
| `refused`                                            | Batches by their first applicable refusal: setting disabled, legacy client, missing incarnation, invalid sequence, retired source or receipt cap                       |
| `breaks`                                             | Run boundary observations by fixed reason; `no_open` includes normal starts, not only failures                                                                         |
| `legacyProjectSocketsMax`, `legacySessionSocketsMax` | Window maxima of connected legacy sockets relevant to the current batch; an unscoped socket is relevant to all sessions                                                |

Primary refusal precedence is `setting_disabled`, `legacy_client`, `missing_incarnation`, `invalid_sequence`, `retired_source`, `receipt_cap`. Run-boundary reasons are `no_open`, `source`, `turn`, `intervening_writer`, `materialized`, `role`, `metadata`, `origin`, `sequence_gap`, `timestamp`, `out_of_order`, `size_cap`. Several independent boundaries can occur in one batch, so boundary counts do not partition batches. Admission of a legacy socket can seal a run before persistence; the sampled socket maxima/refusal counts identify that gate.

Diagnostics publish after the synchronous storage transaction returns, before asynchronous side effects. A rollback contributes no ingestion outcomes; a later broadcast/summary failure does not erase committed outcomes. Received counts include retry input; accepted/inserted/coalesced counts do not include duplicates. Batches that throw before commit contribute no ingestion counts, so SQL RPC calls and `batches` can differ. Existing SQL cursor attribution remains unchanged. Counters reset with the existing log window, have fixed cardinality, perform no SQL writes, and do not create timers or extra log lines.

To distinguish a disabled merger from low eligible traffic, compare refusal reasons and socket maxima first, then accepted role mix, eligible share and coalesced chunks. A build version or enabled D1 setting alone does not prove a batch can merge. Compare production writes/call alongside accepted chunks/call and role mix; changes between unrelated time windows are not a controlled savings measurement.
