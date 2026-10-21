import type { HandoffFact, HandoffPacket } from '@simple-agent-manager/shared';
import * as v from 'valibot';

export type RoutableHandoff = Pick<
  HandoffPacket,
  'id' | 'summary' | 'facts' | 'openQuestions' | 'suggestedActions'
>;

const handoffFactObjectSchema = v.object({
  key: v.optional(v.string()),
  value: v.optional(v.string()),
  fact: v.optional(v.string()),
});

const routableHandoffSchema = v.object({
  id: v.string(),
  summary: v.string(),
  facts: v.optional(v.array(v.union([v.string(), handoffFactObjectSchema]))),
  openQuestions: v.optional(v.array(v.string())),
  suggestedActions: v.optional(v.array(v.string())),
});

/** Build a readable content string from a handoff packet for durable message delivery. */
export function buildHandoffContent(fromTaskId: string, handoff: RoutableHandoff): string {
  const parts: string[] = [
    `Handoff from task ${fromTaskId}:`,
    '',
    `**Summary:** ${handoff.summary}`,
  ];
  if (handoff.facts.length > 0) {
    const facts = handoff.facts.map((fact) => `- ${fact.key}: ${fact.value}`).join('\n');
    parts.push('', `**Key Facts:**\n${facts}`);
  }
  if (handoff.openQuestions.length > 0) {
    const qs = handoff.openQuestions.map((q) => `- ${q}`).join('\n');
    parts.push('', `**Open Questions:**\n${qs}`);
  }
  if (handoff.suggestedActions.length > 0) {
    const acts = handoff.suggestedActions.map((a) => `- ${a}`).join('\n');
    parts.push('', `**Suggested Actions:**\n${acts}`);
  }
  return parts.join('\n');
}

export function parseRoutableHandoff(value: unknown): RoutableHandoff | null {
  const parsed = v.safeParse(routableHandoffSchema, value);
  if (!parsed.success) return null;

  return {
    id: parsed.output.id,
    summary: parsed.output.summary,
    facts: readHandoffFacts(parsed.output.facts),
    openQuestions: parsed.output.openQuestions ?? [],
    suggestedActions: parsed.output.suggestedActions ?? [],
  };
}

function readHandoffFacts(
  value: NonNullable<v.InferOutput<typeof routableHandoffSchema>['facts']> | undefined
): HandoffFact[] {
  return (value ?? []).flatMap((item): HandoffFact[] => {
    if (typeof item === 'string') {
      return [{ key: 'fact', value: item }];
    }
    const key = item.key ? item.key : item.fact ? 'fact' : null;
    const factValue = item.value ? item.value : (item.fact ?? null);
    return key && factValue ? [{ key, value: factValue }] : [];
  });
}
