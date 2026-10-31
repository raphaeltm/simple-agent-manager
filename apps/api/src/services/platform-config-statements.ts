import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { encrypt } from './encryption';
import {
  INTEGRATION_CREDENTIAL_TYPE,
  SECRET_KINDS,
  SETTING_KEYS,
  trimOptional,
} from './platform-config-store';
import type { PlatformIntegrationInput } from './platform-config-types';

export function settingStatement(
  env: Env,
  key: string,
  value: string,
  updatedBy: string,
  now: string
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, value, now, updatedBy);
}

export function deleteSettingStatement(env: Env, key: string): D1PreparedStatement {
  return env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?').bind(key);
}

async function secretUpsertStatement(
  env: Env,
  provider: string,
  kind: string,
  label: string,
  value: string,
  updatedBy: string,
  now: string
): Promise<D1PreparedStatement> {
  const encrypted = await encrypt(value, getCredentialEncryptionKey(env));
  const existing = await env.DATABASE.prepare(
    `SELECT id FROM platform_credentials
     WHERE credential_type = ? AND provider = ? AND credential_kind = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(INTEGRATION_CREDENTIAL_TYPE, provider, kind)
    .first<{ id: string }>();

  if (existing) {
    return env.DATABASE.prepare(
      `UPDATE platform_credentials
       SET label = ?, encrypted_token = ?, iv = ?, is_enabled = 1, updated_by = ?, updated_at = ?
       WHERE id = ?`
    ).bind(label, encrypted.ciphertext, encrypted.iv, updatedBy, now, existing.id);
  }

  return env.DATABASE.prepare(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(
    ulid(),
    INTEGRATION_CREDENTIAL_TYPE,
    provider,
    kind,
    label,
    encrypted.ciphertext,
    encrypted.iv,
    updatedBy,
    now,
    updatedBy,
    now
  );
}

export async function buildPlatformIntegrationStatements(
  env: Env,
  input: PlatformIntegrationInput,
  updatedBy: string,
  now: string
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  const github = input.github ?? {};
  const google = input.google ?? {};
  const googleInfrastructure = input.googleInfrastructure ?? {};
  const gitlab = input.gitlab ?? {};
  const feedback = input.feedback ?? {};

  const githubClientId = trimOptional(github.clientId);
  if (githubClientId)
    statements.push(
      settingStatement(env, SETTING_KEYS.githubClientId, githubClientId, updatedBy, now)
    );

  const githubAppId = trimOptional(github.appId);
  if (githubAppId)
    statements.push(settingStatement(env, SETTING_KEYS.githubAppId, githubAppId, updatedBy, now));

  const githubAppSlug = trimOptional(github.appSlug);
  if (githubAppSlug)
    statements.push(
      settingStatement(env, SETTING_KEYS.githubAppSlug, githubAppSlug, updatedBy, now)
    );

  const googleClientId = trimOptional(google.clientId);
  if (googleClientId)
    statements.push(
      settingStatement(env, SETTING_KEYS.googleClientId, googleClientId, updatedBy, now)
    );

  if (googleInfrastructure.remove) {
    statements.push(
      env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?').bind(
        SETTING_KEYS.googleInfrastructureClientId
      ),
      env.DATABASE.prepare(
        'DELETE FROM platform_credentials WHERE credential_type = ? AND provider = ? AND credential_kind = ?'
      ).bind(
        INTEGRATION_CREDENTIAL_TYPE,
        'google-infrastructure',
        SECRET_KINDS.googleInfrastructureClientSecret
      )
    );
  } else {
    const clientId = trimOptional(googleInfrastructure.clientId);
    if (clientId) {
      statements.push(
        settingStatement(env, SETTING_KEYS.googleInfrastructureClientId, clientId, updatedBy, now)
      );
    }
  }

  const gitlabHost = trimOptional(gitlab.host);
  if (gitlabHost)
    statements.push(settingStatement(env, SETTING_KEYS.gitlabHost, gitlabHost, updatedBy, now));

  const gitlabClientId = trimOptional(gitlab.clientId);
  if (gitlabClientId)
    statements.push(
      settingStatement(env, SETTING_KEYS.gitlabClientId, gitlabClientId, updatedBy, now)
    );

  if (feedback.remove) {
    statements.push(deleteSettingStatement(env, SETTING_KEYS.feedbackProjectId));
  } else {
    const feedbackProjectId = trimOptional(feedback.projectId);
    if (feedbackProjectId) {
      statements.push(
        settingStatement(env, SETTING_KEYS.feedbackProjectId, feedbackProjectId, updatedBy, now)
      );
    }
  }

  const githubClientSecret = trimOptional(github.clientSecret);
  if (githubClientSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'github',
        SECRET_KINDS.githubClientSecret,
        'GitHub OAuth client secret',
        githubClientSecret,
        updatedBy,
        now
      )
    );
  }

  const githubAppPrivateKey = trimOptional(github.appPrivateKey);
  if (githubAppPrivateKey) {
    statements.push(
      await secretUpsertStatement(
        env,
        'github',
        SECRET_KINDS.githubAppPrivateKey,
        'GitHub App private key',
        githubAppPrivateKey,
        updatedBy,
        now
      )
    );
  }

  const githubWebhookSecret = trimOptional(github.webhookSecret);
  if (githubWebhookSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'github',
        SECRET_KINDS.githubWebhookSecret,
        'GitHub webhook secret',
        githubWebhookSecret,
        updatedBy,
        now
      )
    );
  }

  const googleClientSecret = trimOptional(google.clientSecret);
  if (googleClientSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'google',
        SECRET_KINDS.googleClientSecret,
        'Google OAuth client secret',
        googleClientSecret,
        updatedBy,
        now
      )
    );
  }

  if (!googleInfrastructure.remove) {
    const clientSecret = trimOptional(googleInfrastructure.clientSecret);
    if (clientSecret) {
      statements.push(
        await secretUpsertStatement(
          env,
          'google-infrastructure',
          SECRET_KINDS.googleInfrastructureClientSecret,
          'Google infrastructure OAuth client secret',
          clientSecret,
          updatedBy,
          now
        )
      );
    }
  }

  const gitlabClientSecret = trimOptional(gitlab.clientSecret);
  if (gitlabClientSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'gitlab',
        SECRET_KINDS.gitlabClientSecret,
        'GitLab client secret',
        gitlabClientSecret,
        updatedBy,
        now
      )
    );
  }

  return statements;
}
