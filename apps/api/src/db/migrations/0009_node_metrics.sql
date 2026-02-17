-- Add last_metrics column to nodes table for storing lightweight heartbeat metrics.
-- Stores a JSON blob: { cpuLoadAvg1, memoryPercent, diskPercent }
ALTER TABLE nodes ADD COLUMN last_metrics TEXT;
