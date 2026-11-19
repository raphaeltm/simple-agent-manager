-- Agent email durable intake (Astra's review of PR #2413). An inbound email is stored with
-- what its prompt needs (payload_json) and a stable trigger_execution_id before SMTP is
-- answered. From then on SAM owns it: a crashed or failed attempt is retried from this row,
-- each attempt resumes the same execution, and lease_token fences every write an attempt
-- makes. payload_json is cleared once the email is accepted or given up on. Additive only.
ALTER TABLE trigger_email_messages ADD COLUMN payload_json TEXT;
ALTER TABLE trigger_email_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trigger_email_messages ADD COLUMN available_at TEXT;
ALTER TABLE trigger_email_messages ADD COLUMN lease_token TEXT;
CREATE INDEX idx_trigger_email_messages_due
  ON trigger_email_messages(status, available_at) WHERE direction = 'inbound';
