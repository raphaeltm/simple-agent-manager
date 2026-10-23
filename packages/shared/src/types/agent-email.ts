// =============================================================================
// Agent email (prototype): email triggers and replies.
// =============================================================================

/** Input accepted when creating or updating an email trigger. */
export interface EmailTriggerConfigInput {
  /**
   * Exact sender addresses allowed to start the trigger. Matching is case-insensitive.
   * Omitted on create: defaults to the creating user's account email.
   */
  allowedSenders?: string[];
}

/** Email trigger configuration returned by management APIs. */
export interface EmailTriggerConfig {
  /** The address mail must be sent to, e.g. `agent+k3j2h7m9q2xw4n8p@agents.example.com`. */
  address: string;
  /** Lower-cased sender addresses allowed to start the trigger. */
  allowedSenders: string[];
}

/**
 * Variables available as `{{email.*}}`, `{{trigger.*}}`, ... in an email trigger's prompt.
 * A type alias (not an interface) so it is assignable to the template renderer's record type.
 */
export type EmailTemplateContext = {
  email: {
    /** Sender address from the `From:` header. */
    from: string;
    /** Sender display name, or an empty string. */
    fromName: string;
    /** The trigger address the mail was sent to. */
    to: string;
    subject: string;
    /** Plain-text body, truncated to the configured limit. */
    text: string;
    receivedAt: string;
    messageId: string;
    /** One line per attachment: `name (type, bytes)`. Contents are not stored. */
    attachments: string;
  };
  trigger: {
    id: string;
    name: string;
    description: string;
    fireCount: string;
  };
  project: {
    id: string;
    name: string;
  };
  execution: {
    id: string;
    sequenceNumber: string;
  };
};

/** `GET /api/config/agent-email`: whether this deployment can receive and send agent email. */
export interface AgentEmailConfigResponse {
  enabled: boolean;
  /** Domain agent addresses live on, e.g. `agents.example.com`, when enabled. */
  domain: string | null;
}

/** A DNS record Cloudflare adds to the main domain when a zone first turns on Email Routing. */
export interface AgentEmailMainDomainRecord {
  type: string;
  name: string;
  /** Exact content when Cloudflare's value is known in advance; null for a key it generates. */
  content: string | null;
  /** `add`: Cloudflare adds it, or added it unexpectedly. `remove`: it disappeared. */
  change: 'add' | 'remove';
}

/** A zone-wide Email Routing setting the setup changes. */
export interface AgentEmailZoneChange {
  setting: 'subaddressing';
  description: string;
}

/**
 * Where the admin setup stands (`/api/admin/agent-email/setup`):
 * - `unavailable`: this deployment has not prepared agent email; `reason` says what is missing
 * - `verifying`: Cloudflare is still verifying the sending records
 * - `refused`: setup would change mail records the main domain already has
 * - `changed`: an earlier run left the main domain's mail records different from what it
 *   showed; `mainDomainChanges` lists the differences
 * - `needs_consent`: Cloudflare will add `mainDomainChanges`, or the setup will make
 *   `zoneChanges`; the admin must allow them
 * - `ready`: setup changes nothing on the main domain or the zone
 * - `pending`: routing was turned on but its records are not visible yet; run setup again
 * - `on`: agent email is on
 */
export type AgentEmailSetupState =
  | 'unavailable'
  | 'verifying'
  | 'refused'
  | 'changed'
  | 'needs_consent'
  | 'ready'
  | 'pending'
  | 'on';

export interface AgentEmailSetupPlan {
  state: AgentEmailSetupState;
  /** Domain agent addresses live on, e.g. `agents.example.com`. */
  domain: string | null;
  /** The zone's root domain, which `mainDomainChanges` apply to. */
  mainDomain: string | null;
  mainDomainChanges: AgentEmailMainDomainRecord[];
  zoneChanges: AgentEmailZoneChange[];
  /** Set when the admin must allow the listed changes; the run accepts only this value. */
  consentToken: string | null;
  reason: string | null;
}

/** `POST /api/admin/agent-email/setup`. */
export interface AgentEmailSetupRequest {
  /** The plan's `consentToken`: the admin allows exactly the changes that plan listed. */
  consentToken?: string;
}
