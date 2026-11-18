/** Input fields of `sam_agent_answer`: the one answer a client may give to a pending agent question. */
import * as v from 'valibot';

export const ConnectorAnswerFields = {
  optionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  decline: v.optional(v.literal(true)),
  formContent: v.optional(v.record(v.string(), v.unknown())),
};

export interface ConnectorAnswerChoice {
  optionId?: string;
  decline?: true;
  formContent?: Record<string, unknown>;
}
