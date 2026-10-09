-- Persist human-visible connector attribution without storing credentials.
ALTER TABLE tasks ADD COLUMN connector_client_name TEXT;
