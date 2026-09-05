-- Pin each managed runtime to the exact encrypted credential generation used to create it.
-- Existing runtimes remain NULL and therefore fail closed during strict deletion: a mutable
-- credential row cannot be retroactively proven to still name the original provider account.
ALTER TABLE nodes ADD COLUMN placement_credential_fingerprint TEXT;
