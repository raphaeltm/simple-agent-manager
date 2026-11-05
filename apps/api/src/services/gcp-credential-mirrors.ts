import { sql } from 'drizzle-orm';

import type { Db } from './provider-catalogs-common';

export interface ManagedGcpCredentialMirror {
  legacyId: string;
  credentialId: string;
  attachmentId: string;
}

/**
 * Compatibility copies are not independent cloud accounts. Compare encrypted bytes in D1
 * (never decrypt or return them), and require the writer's marker, exact ownership/scope,
 * and a unique legacy match. Unmarked connections and project attachments stay independent.
 * This also recognizes random-ID copies written before an explicit legacy ID was stored.
 */
export function managedGcpCredentialMirrorsQuery(userId: string) {
  return sql`
    SELECT legacy.id AS legacyId, credential.id AS credentialId, attachment.id AS attachmentId
    FROM cc_attachments AS attachment
    JOIN cc_configurations AS configuration ON configuration.id = attachment.configuration_id
    JOIN cc_credentials AS credential ON credential.id = configuration.credential_id
    JOIN credentials AS legacy ON legacy.user_id = attachment.user_id
      AND legacy.project_id IS NULL AND legacy.provider = 'gcp'
      AND legacy.credential_type = 'cloud-provider'
      AND legacy.encrypted_token = credential.encrypted_token AND legacy.iv = credential.iv
    WHERE attachment.user_id = ${userId} AND attachment.project_id IS NULL
      AND attachment.consumer_kind = 'compute' AND attachment.consumer_target = 'gcp'
      AND configuration.owner_id = attachment.user_id
      AND configuration.consumer_kind = 'compute' AND configuration.consumer_target = 'gcp'
      AND credential.owner_id = attachment.user_id AND credential.kind = 'cloud-provider'
      AND attachment.is_active = 1 AND configuration.is_active = 1
      AND credential.is_active = 1 AND legacy.is_active = 1
      AND legacy.id IS NOT NULL
      AND credential.encrypted_token != '' AND credential.iv != ''
      AND CASE WHEN json_valid(configuration.settings_json)
        THEN json_extract(configuration.settings_json, '$.managedBy') END = 'legacy-gcp-credential'
      AND (CASE WHEN json_valid(configuration.settings_json)
        THEN json_extract(configuration.settings_json, '$.legacyCredentialId') END IS NULL
        OR CASE WHEN json_valid(configuration.settings_json)
          THEN json_extract(configuration.settings_json, '$.legacyCredentialId') END = legacy.id)
      AND NOT EXISTS (
        SELECT 1 FROM credentials AS other WHERE other.id != legacy.id
          AND other.user_id = legacy.user_id AND other.project_id IS NULL
          AND other.provider = 'gcp' AND other.credential_type = 'cloud-provider'
          AND other.is_active = 1 AND other.encrypted_token = legacy.encrypted_token
          AND other.iv = legacy.iv
      )`;
}

/** Read confirmed compatibility pairs without exposing encrypted credential bytes. */
export function listManagedGcpCredentialMirrors(db: Db, userId: string) {
  return db.all<ManagedGcpCredentialMirror>(managedGcpCredentialMirrorsQuery(userId));
}
