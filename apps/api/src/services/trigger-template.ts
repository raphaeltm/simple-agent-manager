import type { CronTemplateContext, Trigger } from '@simple-agent-manager/shared';
import {
  DEFAULT_CRON_TEMPLATE_MAX_FIELD_LENGTH,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
} from '@simple-agent-manager/shared';

// =============================================================================
// Mustache-Style Template Rendering Engine
// Supports {{variable.path}} interpolation with safety guarantees:
// - No triple-brace (unescaped) support
// - HTML entities sanitized in interpolated values
// - Per-field and total length limits enforced
// =============================================================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface RenderResult {
  rendered: string;
  warnings: string[];
}

/**
 * Render a Mustache-style template with the given context.
 *
 * - Replaces `{{path.to.value}}` with the corresponding context value
 * - Missing variables are replaced with empty string and generate a warning
 * - Triple-braces `{{{...}}}` are not supported (treated as `{{...}}` with extra braces left)
 * - HTML special characters in interpolated values are escaped
 *
 * @param template - The template string with {{variable}} placeholders
 * @param context - Key-value context object (supports nested paths via dot notation)
 * @param maxLength - Maximum rendered output length. Override via CRON_TEMPLATE_MAX_LENGTH env var.
 * @param maxFieldLength - Maximum length per interpolated field. Override via CRON_TEMPLATE_MAX_FIELD_LENGTH env var.
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  maxLength: number = DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  maxFieldLength: number = DEFAULT_CRON_TEMPLATE_MAX_FIELD_LENGTH
): RenderResult {
  const warnings: string[] = [];

  // Replace {{path}} patterns
  const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => {
    const trimmedPath = path.trim();
    const value = resolvePath(context, trimmedPath);

    if (value === undefined || value === null) {
      warnings.push(`Missing variable: {{${trimmedPath}}}`);
      return '';
    }

    let strValue = String(value);

    // Enforce per-field length limit
    if (strValue.length > maxFieldLength) {
      strValue = strValue.slice(0, maxFieldLength);
      warnings.push(
        `Variable {{${trimmedPath}}} truncated to ${maxFieldLength} characters`
      );
    }

    // Sanitize HTML special characters to prevent injection
    return sanitizeHtml(strValue);
  });

  // Enforce total length limit
  if (rendered.length > maxLength) {
    warnings.push(`Rendered template truncated to ${maxLength} characters`);
    return { rendered: rendered.slice(0, maxLength), warnings };
  }

  return { rendered, warnings };
}

/**
 * Resolve a dot-separated path against a nested object.
 * e.g., resolvePath({schedule: {time: "2026-04-09"}}, "schedule.time") → "2026-04-09"
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/** Escape HTML special characters to prevent injection in rendered prompts. */
function sanitizeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Build the full CronTemplateContext from a trigger and the current time.
 * Used at cron fire time to populate template variables.
 *
 * @param trigger - The trigger configuration
 * @param now - The scheduled fire time
 * @param projectName - The project name (resolved at fire time)
 * @param executionId - The execution ID
 * @param sequenceNumber - The execution sequence number for this trigger
 */
export function buildCronContext(
  trigger: Pick<Trigger, 'id' | 'name' | 'description' | 'triggerCount' | 'cronTimezone' | 'projectId'>,
  now: Date,
  projectName: string,
  executionId: string,
  sequenceNumber: number
): CronTemplateContext {
  const timezone = trigger.cronTimezone || 'UTC';

  // Get timezone-aware date components
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  let hour = get('hour');
  if (hour === '24') hour = '00';

  // Build the date string in YYYY-MM-DD format
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const dateStr = `${year}-${month}-${day}`;

  // Weekday from Intl
  let weekday = get('weekday');
  if (!weekday) {
    // Fallback to UTC day name
    weekday = DAY_NAMES[now.getUTCDay()] ?? 'Unknown';
  }

  return {
    schedule: {
      time: now.toISOString(),
      date: dateStr,
      dayOfWeek: weekday,
      hour,
      minute: get('minute'),
      timezone,
    },
    trigger: {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description ?? '',
      fireCount: String(trigger.triggerCount + 1), // +1 because this is the current fire
    },
    project: {
      id: trigger.projectId,
      name: projectName,
    },
    execution: {
      id: executionId,
      sequenceNumber: String(sequenceNumber),
    },
  };
}
