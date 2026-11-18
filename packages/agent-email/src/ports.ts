/**
 * What agent email needs from the rest of the worker. The worker builds an `AgentEmailPorts`
 * bound to its environment for each call and passes it in; the package never imports worker
 * modules.
 */
import type { TriggerRow } from '@simple-agent-manager/worker-core/schema';

import type { AgentEmailSettingName } from './setting-definitions';

/** Input for the shared trigger admission path when an email starts its trigger. */
export interface AgentEmailTriggerAdmissionInput {
  trigger: TriggerRow;
  eventType: 'email';
  triggeredBy: 'email';
  scheduledAt: string;
  /** The execution id stored with the email: a retry resumes that execution. */
  executionId: string;
  /** Admission writes apply only while this attempt still holds the email's lease. */
  emailLease: { rowId: string; leaseToken: string };
  beforeSubmit: (executionId: string) => Promise<void>;
  renderPrompt: (executionId: string, sequenceNumber: number) => string;
}

/** Outcome of trigger admission, as the email delivery path consumes it. */
export type AgentEmailTriggerAdmissionResult =
  | { outcome: 'submitted'; executionId: string }
  | { outcome: 'pending'; executionId: string }
  | { outcome: 'skipped'; executionId: string; reason: string }
  | { outcome: 'inactive'; reason: 'paused' | 'disabled' }
  | { outcome: 'failed'; executionId: string; error: string };

export interface CloudflareApiPort {
  /** Base URL of the Cloudflare v4 API. */
  baseUrl: string;
  /** Default timeout for Cloudflare API calls when `CF_API_TIMEOUT_MS` is unset. */
  defaultTimeoutMs: number;
  /** Read Cloudflare's error envelope; never throws, falls back to `fallback`. */
  readErrorDetail(
    response: Response,
    fallback: string
  ): Promise<{ code: number | null; message: string }>;
}

export interface AgentEmailPorts {
  /** Admin-editable runtime setting; degrades to the registry default on a store outage. */
  resolveAdminSetting(name: AgentEmailSettingName): Promise<unknown>;
  /** Stored platform setting value, or null when unset. */
  readPlatformSetting(key: string): Promise<string | null>;
  /** KV rate limit over a fixed one-hour window. True while the caller is within `limit`. */
  withinHourlyRateLimit(scope: string, id: string, limit: number): Promise<boolean>;
  /** Alert operators that the recovery sweep gave up on an email. */
  notifyDeliveryGaveUp(): Promise<void>;
  /** Shared trigger admission and task submission for one email. */
  admitAndSubmitTrigger(
    input: AgentEmailTriggerAdmissionInput
  ): Promise<AgentEmailTriggerAdmissionResult>;
  /** Shared trigger prompt renderer (`{{path}}` placeholders, length caps). */
  renderTemplate(
    template: string,
    context: Record<string, unknown>,
    maxLength: number,
    maxFieldLength: number
  ): { rendered: string };
  cloudflareApi: CloudflareApiPort;
}
