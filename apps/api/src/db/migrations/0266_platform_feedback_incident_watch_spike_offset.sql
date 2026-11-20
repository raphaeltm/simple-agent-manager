-- Spike counting for watched incidents from the watch decision itself (follows 0265).
--
-- watch_spike_offset  occurrences already in the hourly bucket of the watch decision when it was
--                     made. The spike count includes that hour and subtracts this offset, so a
--                     burst right after the decision counts, and a burst triage already saw
--                     before it does not.
--
-- Additive and nullable; NULL reads as 0.
ALTER TABLE platform_feedback_triages ADD COLUMN watch_spike_offset INTEGER;
