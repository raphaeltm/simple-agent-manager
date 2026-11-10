#!/usr/bin/env node
// Throwaway: print SQL that seeds one superadmin user + a PAT for token-login, and the raw token.
// usage: node seed-user.mjs <secrets.json>   -> writes seed.sql and token.txt next to secrets.json
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const secretsPath = resolve(process.argv[2]);
const { ENCRYPTION_KEY } = JSON.parse(readFileSync(secretsPath, 'utf8'));
const raw = 'sam_pat_' + crypto.randomBytes(32).toString('base64url');
const hash = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'utf8')).update(raw).digest('hex');
const now = Date.now();
const sql = `INSERT INTO users (id,email,email_verified,name,role,status,created_at,updated_at)
VALUES ('spike-user-1','spike@example.invalid',1,'Spike User','superadmin','active',${now},${now});
INSERT INTO smoke_test_tokens (id,user_id,token_hash,name,created_at) VALUES ('spike-token-1','spike-user-1','${hash}','spike',${now});`;
const dir = dirname(secretsPath);
writeFileSync(resolve(dir, 'seed.sql'), sql + '\n');
writeFileSync(resolve(dir, 'token.txt'), raw);
console.log('wrote seed.sql and token.txt');
