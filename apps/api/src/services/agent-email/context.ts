/** Prompt template context for email triggers: `{{email.*}}`, `{{trigger.*}}`, ... */
import {
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  type EmailTemplateContext,
} from '@simple-agent-manager/shared';

import { renderTemplate } from '../trigger-template';
import type { InboundAgentEmail, InboundAttachmentSummary } from './inbound-message';

interface ContextTrigger {
  id: string;
  name: string;
  description: string | null;
  triggerCount: number;
  projectId: string;
}

export interface BuildEmailContextInput {
  email: Pick<
    InboundAgentEmail,
    'from' | 'fromName' | 'subject' | 'text' | 'textTruncated' | 'messageId' | 'attachments'
  >;
  address: string;
  receivedAt: string;
  trigger: ContextTrigger;
  projectName: string;
  executionId: string;
  sequenceNumber: number;
}

function describeAttachments(attachments: InboundAttachmentSummary[]): string {
  return attachments
    .map(
      (attachment) => `${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)`
    )
    .join('\n');
}

export function buildEmailContext(input: BuildEmailContextInput): EmailTemplateContext {
  const { email } = input;
  const text = email.textTruncated
    ? `${email.text}\n\n[SAM: the rest of this email was cut off at ${email.text.length} characters]`
    : email.text;
  return {
    email: {
      from: email.from ?? '',
      fromName: email.fromName,
      to: input.address,
      subject: email.subject,
      text,
      receivedAt: input.receivedAt,
      messageId: email.messageId ?? '',
      attachments: describeAttachments(email.attachments),
    },
    trigger: {
      id: input.trigger.id,
      name: input.trigger.name,
      description: input.trigger.description ?? '',
      fireCount: String(input.trigger.triggerCount + 1),
    },
    project: { id: input.trigger.projectId, name: input.projectName },
    execution: { id: input.executionId, sequenceNumber: String(input.sequenceNumber) },
  };
}

/** A representative email for previews. Run now is refused for email triggers. */
export function sampleEmailContext(
  input: Omit<BuildEmailContextInput, 'email'> & { from: string }
): EmailTemplateContext {
  return buildEmailContext({
    ...input,
    email: {
      from: input.from,
      fromName: 'Example Sender',
      subject: 'Example: can you take a look at this?',
      text: 'Hi! This is an example email body, shown so you can preview the prompt.',
      textTruncated: false,
      messageId: '<example@mail.example.com>',
      attachments: [],
    },
  });
}

/**
 * Render an email trigger's prompt. The body field may be as long as the configured body
 * limit, so the field and total caps grow with it instead of using the cron defaults.
 */
export function renderEmailPrompt(
  template: string,
  context: EmailTemplateContext,
  maxBodyChars: number
): string {
  // EmailTemplateContext is built entirely by buildEmailContext; the widening only satisfies
  // renderTemplate's structural Record parameter.
  const record = context as unknown as Record<string, unknown>;
  const fieldLimit = maxBodyChars + 200;
  return renderTemplate(template, record, DEFAULT_CRON_TEMPLATE_MAX_LENGTH + fieldLimit, fieldLimit)
    .rendered;
}
