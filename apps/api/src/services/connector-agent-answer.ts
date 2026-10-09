import type {
  AcpInteractionAnswerDecision,
  AcpInteractionBrowserAnswer,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { validFormAnswerDecision } from '../durable-objects/interaction-store-form';
import { sha256 } from '../durable-objects/interaction-store-model';
import type { Env } from '../env';
import { OperationError } from '../operations/errors';
import { getAcpInteractionConfig } from './acp-interaction-config';
import { getInteractionDetail, getPendingInteractionDetails } from './acp-interaction-store';

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

/** Same receipt hashes as the browser cards; clients never manufacture crypto metadata. */
export async function prepareConnectorAgentAnswer(
  env: Env,
  projectId: string,
  sessionId: string,
  interactionId: string,
  input: ConnectorAnswerChoice
): Promise<AcpInteractionBrowserAnswer> {
  if (
    [input.optionId !== undefined, input.decline === true, input.formContent !== undefined].filter(
      Boolean
    ).length !== 1
  )
    throw new OperationError(
      'invalid_input',
      'Supply exactly one optionId, decline:true, or formContent'
    );
  const interaction = await getInteractionDetail(env, projectId, sessionId, interactionId);
  if (!interaction?.detail)
    throw new OperationError('not_found', 'Interaction details are unavailable; refresh the chat');
  let decision: AcpInteractionAnswerDecision;
  if (input.decline) decision = { kind: 'declined', answerHash: await sha256('declined') };
  else if (interaction.summary.kind === 'permission' && input.optionId) {
    const options = interaction.detail.options;
    if (
      !Array.isArray(options) ||
      !options.some(
        (option) =>
          typeof option === 'object' &&
          option !== null &&
          'id' in option &&
          option.id === input.optionId
      )
    )
      throw new OperationError(
        'invalid_input',
        'optionId must be one of the pending permission options'
      );
    decision = {
      kind: 'selected_option',
      optionId: input.optionId,
      answerHash: await sha256(input.optionId),
    };
  } else if (interaction.summary.kind === 'form' && input.formContent) {
    const content = Object.fromEntries(
      Object.entries(input.formContent).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
    decision = { kind: 'accepted', content, answerHash: await sha256(JSON.stringify(content)) };
    if (
      (await validFormAnswerDecision(
        interaction.detail.schema,
        decision,
        getAcpInteractionConfig(env)
      )) !== 'valid'
    )
      throw new OperationError(
        'invalid_input',
        'formContent does not match the pending form schema'
      );
  } else if (interaction.summary.kind === 'url' && input.optionId === 'accept')
    decision = { kind: 'accepted', answerHash: await sha256('accepted') };
  else
    throw new OperationError(
      'invalid_input',
      'Use optionId for permissions, formContent for forms, optionId:"accept" for URL requests, or decline:true'
    );
  return { answerKey: crypto.randomUUID(), decision };
}

export async function connectorPendingInteractions(env: Env, projectId: string, sessionId: string) {
  const pending = await getPendingInteractionDetails(env, projectId, sessionId);
  return pending.map((item) => ({
    ...item,
    untrustedContent: true,
    canDecline: true,
    ...(item.kind === 'permission'
      ? { answerOptions: Array.isArray(item.detail?.options) ? item.detail.options : [] }
      : {}),
    ...(item.kind === 'form' ? { formSchema: item.detail?.schema ?? null } : {}),
    ...(item.kind === 'url'
      ? { answerOptions: [{ id: 'accept', name: 'Acknowledge URL request' }] }
      : {}),
  }));
}
