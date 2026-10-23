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
}

/**
 * Where the admin setup stands (`/api/admin/agent-email/setup`):
 * - `unavailable`: this deployment has not prepared agent email; `reason` says what is missing
 * - `verifying`: Cloudflare is still verifying the sending records
 * - `refused`: setup would change mail records the main domain already has
 * - `needs_consent`: the zone is new to Email Routing, so Cloudflare will add `mainDomainChanges`
 * - `ready`: setup changes nothing on the main domain
 * - `pending`: routing was turned on but its records are not visible yet; run setup again
 * - `on`: agent email is on
 */
export type AgentEmailSetupState =
  'unavailable' | 'verifying' | 'refused' | 'needs_consent' | 'ready' | 'pending' | 'on';

export interface AgentEmailSetupPlan {
  state: AgentEmailSetupState;
  /** Domain agent addresses live on, e.g. `agents.example.com`. */
  domain: string | null;
  /** The zone's root domain, which `mainDomainChanges` apply to. */
  mainDomain: string | null;
  mainDomainChanges: AgentEmailMainDomainRecord[];
  reason: string | null;
}

/** `POST /api/admin/agent-email/setup`. */
export interface AgentEmailSetupRequest {
  /** Required when the plan lists main-domain changes: the admin allows exactly those. */
  allowMainDomainChanges?: boolean;
}
