# Approval-required resource-history repair proposal

This is a reviewed proposal, not an authorized production operation. Extract the SQL fence only after the fresh audit, backup, and approval described in the task record.

```sql
-- PROPOSAL ONLY. Requires explicit approval before production execution.

-- Snapshot 2026-10-05. 45 summaries; remove 4248 excess samples and 213 excess tool spans.

-- Execute via a single D1 batch. Each UPDATE checks original counts, timestamp,

-- complete first/latest chunk presence and snapshot chunk totals/count.

-- No chunk rows or R2 objects are changed. Any 0-row update requires re-audit.

UPDATE workspace_resource_summaries
SET sample_count = 3013, tool_span_count = 1024
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M3CWCRKZP6C39MMWQM24NGJ8:session:9b1d34a2-e3a1-4e01-896c-88136305c991'
  AND updated_at = 1790375149841 AND sample_count = 3193 AND tool_span_count = 1086
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 17
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3013
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1024;

UPDATE workspace_resource_summaries
SET sample_count = 2935, tool_span_count = 970
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M3CWCWFPS4QN31TMTHAXH4HK:session:83ebe8f1-c52d-4b8c-bdc9-72470cba1a23'
  AND updated_at = 1790374760473 AND sample_count = 3116 AND tool_span_count = 1043
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 17
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2935
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 970;

UPDATE workspace_resource_summaries
SET sample_count = 3578, tool_span_count = 1177
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M3E4G2Z8BXEY57A701DCDJEC:session:1df85b1b-5820-4cae-9d44-54558528d808'
  AND updated_at = 1790420010015 AND sample_count = 3759 AND tool_span_count = 1187
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 20
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3578
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1177;

UPDATE workspace_resource_summaries
SET sample_count = 2708, tool_span_count = 694
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M3GD345Z5B3VPBR7DS7X5SCG:session:c5eb6829-e940-40cb-902f-2638e71c854e'
  AND updated_at = 1790491766889 AND sample_count = 2889 AND tool_span_count = 694
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 15
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2708
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 694;

UPDATE workspace_resource_summaries
SET sample_count = 1781, tool_span_count = 31
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M40RQ0PAY5P4WD6MXRM6TJGT:session:5856fe01-4736-4c5c-a10e-62b191edc0bd'
  AND updated_at = 1791036185314 AND sample_count = 1876 AND tool_span_count = 31
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 11
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1781
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 31;

UPDATE workspace_resource_summaries
SET sample_count = 3576, tool_span_count = 1480
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M42YTBWMDH6CXCM8EVCDF0SZ:session:09741e8b-bae5-4b48-a228-f96263981023'
  AND updated_at = 1791118678492 AND sample_count = 3722 AND tool_span_count = 1501
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 20
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3576
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1480;

UPDATE workspace_resource_summaries
SET sample_count = 1729, tool_span_count = 467
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M4378H2TMB4PKD62J1B7T06M:session:9a44a430-3eff-4657-b77b-9d0cf665b033'
  AND updated_at = 1791118287654 AND sample_count = 1770 AND tool_span_count = 467
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 11
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1729
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 467;

UPDATE workspace_resource_summaries
SET sample_count = 2148, tool_span_count = 40
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M439AKSNCHSTA18NWDHNAY8N:session:c02f6669-0299-492e-8a5d-999635442c93'
  AND updated_at = 1791122556323 AND sample_count = 2245 AND tool_span_count = 40
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 13
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2148
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 40;

UPDATE workspace_resource_summaries
SET sample_count = 1146, tool_span_count = 484
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43B7YF3FGT5EXNJ5MM4H485:session:280ff899-18c4-4f33-b36b-4d402f23b3bc'
  AND updated_at = 1791119558836 AND sample_count = 1147 AND tool_span_count = 484
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 8
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1146
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 484;

UPDATE workspace_resource_summaries
SET sample_count = 382, tool_span_count = 5
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43GWR3Z5AEX4N1FHNKNNAVW:session:9a44a430-3eff-4657-b77b-9d0cf665b033'
  AND updated_at = 1791121658457 AND sample_count = 521 AND tool_span_count = 5
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 382
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 5;

UPDATE workspace_resource_summaries
SET sample_count = 802, tool_span_count = 147
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43GWSNG0X33FF025YGNG2KY:session:280ff899-18c4-4f33-b36b-4d402f23b3bc'
  AND updated_at = 1791123755880 AND sample_count = 819 AND tool_span_count = 147
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 6
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 802
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 147;

UPDATE workspace_resource_summaries
SET sample_count = 352, tool_span_count = 4
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43HB2PHQ3PJAS8FA5WYGQ8E:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791121976667 AND sample_count = 461 AND tool_span_count = 4
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 352
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 4;

UPDATE workspace_resource_summaries
SET sample_count = 336, tool_span_count = 16
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43N3ZT92PSNF8YEP08W92BJ:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791125857428 AND sample_count = 429 AND tool_span_count = 16
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 336
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 16;

UPDATE workspace_resource_summaries
SET sample_count = 1905, tool_span_count = 245
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43NBW1JX6WC84WW3V1MHHR9:session:2fc6c33f-7d71-4d83-bce7-bdae4c56ffcd'
  AND updated_at = 1791133964482 AND sample_count = 2005 AND tool_span_count = 245
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 11
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1905
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 245;

UPDATE workspace_resource_summaries
SET sample_count = 323, tool_span_count = 15
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43NFG9XBM7SSN7Q6VY5H33V:session:5ce09401-1d6a-443e-806e-498f4381373b'
  AND updated_at = 1791126165715 AND sample_count = 403 AND tool_span_count = 15
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 323
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 15;

UPDATE workspace_resource_summaries
SET sample_count = 307, tool_span_count = 124
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43Q8YFYHDDXGHQFXAVCX0DF:session:chat_01M43Q89REEKKPRPATVCT15RTM'
  AND updated_at = 1791127973897 AND sample_count = 371 AND tool_span_count = 144
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 307
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 124;

UPDATE workspace_resource_summaries
SET sample_count = 324, tool_span_count = 2
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43RWZ5D91F10A0V40BN5DP0:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791129762043 AND sample_count = 405 AND tool_span_count = 2
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 324
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2;

UPDATE workspace_resource_summaries
SET sample_count = 408, tool_span_count = 28
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M43WG9PMDVA5R4W95Y4BCNPD:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791133964476 AND sample_count = 573 AND tool_span_count = 28
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 408
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 28;

UPDATE workspace_resource_summaries
SET sample_count = 271, tool_span_count = 2
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44CB6CRABEBNWTVECESB70C:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791149889999 AND sample_count = 300 AND tool_span_count = 2
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 271
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2;

UPDATE workspace_resource_summaries
SET sample_count = 113, tool_span_count = 0
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44CGV798VN3N6ZM47S4KBWC:session:ba34fe12-1b36-4b4c-b45b-cf9605d73ed3'
  AND updated_at = 1791149281208 AND sample_count = 164 AND tool_span_count = 0
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 113
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 0;

UPDATE workspace_resource_summaries
SET sample_count = 17177, tool_span_count = 0
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44CRKWT4PXGQDMMVJNW0RT8:session:5cd63e28-6191-4704-b00e-3c1f05dcef91'
  AND updated_at = 1791234852407 AND sample_count = 17199 AND tool_span_count = 0
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 96
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 17177
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 0;

UPDATE workspace_resource_summaries
SET sample_count = 315, tool_span_count = 12
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44CWTHJKPBXTP5Q2QRK1P7X:session:5cd63e28-6191-4704-b00e-3c1f05dcef91'
  AND updated_at = 1791150685566 AND sample_count = 388 AND tool_span_count = 12
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 315
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 12;

UPDATE workspace_resource_summaries
SET sample_count = 291, tool_span_count = 3
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44FXZ1SDCWAGFW6TBE7VPF4:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791153752100 AND sample_count = 340 AND tool_span_count = 3
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 291
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3;

UPDATE workspace_resource_summaries
SET sample_count = 310, tool_span_count = 4
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44HVJKRCJ967ZWC1NXN2KAS:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791155863703 AND sample_count = 378 AND tool_span_count = 4
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 310
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 4;

UPDATE workspace_resource_summaries
SET sample_count = 331, tool_span_count = 5
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44KRC64JWEMKQ1TD6BEKEKE:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791157959107 AND sample_count = 420 AND tool_span_count = 5
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 331
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 5;

UPDATE workspace_resource_summaries
SET sample_count = 299, tool_span_count = 14
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44NMMW5ZZF5P6VQPNPYHNHT:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791159773919 AND sample_count = 356 AND tool_span_count = 14
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 299
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 14;

UPDATE workspace_resource_summaries
SET sample_count = 294, tool_span_count = 2
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M44Q2W10WHZVTSZ1EEF97E59:session:37f2b832-c7f5-4820-a5bc-ab134de3f543'
  AND updated_at = 1791161266595 AND sample_count = 346 AND tool_span_count = 2
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 294
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2;

UPDATE workspace_resource_summaries
SET sample_count = 664, tool_span_count = 30
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M456S060CFKM0NEXA4V5026N:session:287548bc-a544-4d9b-a4c0-491f44913671'
  AND updated_at = 1791179567939 AND sample_count = 725 AND tool_span_count = 30
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 5
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 664
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 30;

UPDATE workspace_resource_summaries
SET sample_count = 1550, tool_span_count = 2815
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45AGFV89S1GY4A0NJKD92VV:session:chat_01M45AG431MM1A1ERVN3PJ2HZK'
  AND updated_at = 1791187916012 AND sample_count = 1593 AND tool_span_count = 2815
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 10
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1550
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2815;

UPDATE workspace_resource_summaries
SET sample_count = 1464, tool_span_count = 395
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45D6EG65F0JSNBJC90S9YCM:session:01889d57-bfde-4aa8-9a3b-85190d57b613'
  AND updated_at = 1791190315262 AND sample_count = 1604 AND tool_span_count = 395
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 9
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1464
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 395;

UPDATE workspace_resource_summaries
SET sample_count = 397, tool_span_count = 9
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45J0RA3D2SNAEJJA4F3H14N:session:09b8be53-b31c-4bfb-9ef8-5ebdabc286cd'
  AND updated_at = 1791190016941 AND sample_count = 551 AND tool_span_count = 9
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 397
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 9;

UPDATE workspace_resource_summaries
SET sample_count = 3604, tool_span_count = 0
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45MRQQ9C09Y0FQKNS85YHMQ:session:chat_01M45MRD2N4KTMCCXHVB9B5AK2'
  AND updated_at = 1791208936614 AND sample_count = 3716 AND tool_span_count = 0
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 21
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3604
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 0;

UPDATE workspace_resource_summaries
SET sample_count = 1079, tool_span_count = 122
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45MRZ6AVVSYTWT81NBFX76S:session:chat_01M45MRPCC7XVZ0A435VWACT2D'
  AND updated_at = 1791196324542 AND sample_count = 1193 AND tool_span_count = 132
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 7
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1079
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 122;

UPDATE workspace_resource_summaries
SET sample_count = 2352, tool_span_count = 292
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45WQY93FKAQXC9P97W8HK05:session:8bf8f85d-b4d9-4496-a15b-b1ea1180f485'
  AND updated_at = 1791211042912 AND sample_count = 2474 AND tool_span_count = 292
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 14
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2352
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 292;

UPDATE workspace_resource_summaries
SET sample_count = 763, tool_span_count = 9
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M45WVX1FFGVEDA84XF18FYRV:session:01889d57-bfde-4aa8-9a3b-85190d57b613'
  AND updated_at = 1791203222006 AND sample_count = 923 AND tool_span_count = 9
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 5
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 763
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 9;

UPDATE workspace_resource_summaries
SET sample_count = 2167, tool_span_count = 319
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M463EVZWNNEDST2B8BW15XGN:session:5077979d-757a-4dce-83da-aa219b436f74'
  AND updated_at = 1791217157435 AND sample_count = 2287 AND tool_span_count = 319
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 13
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2167
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 319;

UPDATE workspace_resource_summaries
SET sample_count = 6152, tool_span_count = 1469
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M464DQWATP1K7ZPXJDF3WS3N:session:e3cb7c8a-8cc8-4e31-8233-c04890858c08'
  AND updated_at = 1791238093434 AND sample_count = 6282 AND tool_span_count = 1469
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 35
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 6152
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 1469;

UPDATE workspace_resource_summaries
SET sample_count = 685, tool_span_count = 532
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M465V1RA3M2RH08G9B1FGJN3:session:e990de58-2d5c-4be5-8218-7084488efd73'
  AND updated_at = 1791212243848 AND sample_count = 766 AND tool_span_count = 532
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 5
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 685
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 532;

UPDATE workspace_resource_summaries
SET sample_count = 317, tool_span_count = 12
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M467K62S8S474NHJ6AV4TEJS:session:ddd71158-f938-44df-a379-042b952361f1'
  AND updated_at = 1791212243814 AND sample_count = 392 AND tool_span_count = 12
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 317
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 12;

UPDATE workspace_resource_summaries
SET sample_count = 662, tool_span_count = 119
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M469RRRMP75WK55GKYKQDCWH:session:chat_01M469R11MM1XQ8WE4NNN8RF5N'
  AND updated_at = 1791216256036 AND sample_count = 720 AND tool_span_count = 131
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 5
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 662
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 119;

UPDATE workspace_resource_summaries
SET sample_count = 364, tool_span_count = 2
WHERE id = 'workspace:01KHRJGANBBWGDY1NZ0KVF0D4J:01M46AAX7944QGX53J5TKQ24R5:session:e5ed1c13-8669-4962-9149-14d5be95391e'
  AND updated_at = 1791215353119 AND sample_count = 486 AND tool_span_count = 2
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 364
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 2;

UPDATE workspace_resource_summaries
SET sample_count = 243, tool_span_count = 28
WHERE id = 'workspace:01KK26ZXDF2067T5592MBP4013:01M458S9Y37QD9T469K0SJ1HT8:session:chat_01M458RW1GF4Y0T1TZ1E07ZVH2'
  AND updated_at = 1791179568845 AND sample_count = 244 AND tool_span_count = 28
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 3
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 243
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 28;

UPDATE workspace_resource_summaries
SET sample_count = 884, tool_span_count = 97
WHERE id = 'workspace:01KK26ZXDF2067T5592MBP4013:01M45AKSK9NVR4SJMJQFGDFVTM:session:chat_01M45AGECQGZJ68JJMM5A92AP1'
  AND updated_at = 1791184691190 AND sample_count = 985 AND tool_span_count = 102
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 6
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 884
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 97;

UPDATE workspace_resource_summaries
SET sample_count = 489, tool_span_count = 68
WHERE id = 'workspace:01M0DBDR9RVTP2RVE03EFWWTJK:01M45M502XMV4Z1XJSTP6J9FX2:session:73a99c76-948c-4649-bd00-0a5dd909e846'
  AND updated_at = 1791192718403 AND sample_count = 554 AND tool_span_count = 68
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 4
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 489
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 68;

UPDATE workspace_resource_summaries
SET sample_count = 571, tool_span_count = 148
WHERE id = 'workspace:01M0DBDR9RVTP2RVE03EFWWTJK:01M467CPRB7JTHHGHMS5ZBA20Y:session:73a99c76-948c-4649-bd00-0a5dd909e846'
  AND updated_at = 1791213299791 AND sample_count = 719 AND tool_span_count = 148
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = first_chunk_id)
  AND EXISTS (SELECT 1 FROM workspace_resource_chunks WHERE id = latest_chunk_id)
  AND (SELECT COUNT(*) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 4
  AND (SELECT SUM(sample_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 571
  AND (SELECT SUM(tool_span_count) FROM workspace_resource_chunks WHERE summary_id = workspace_resource_summaries.id) = 148;
```
