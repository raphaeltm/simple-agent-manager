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
