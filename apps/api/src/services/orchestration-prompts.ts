import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';

type PersistOrchestrationPromptInput = {
  env: Env;
  projectId: string;
  chatSessionId: string;
  content: string;
  messageId?: string;
  source: string;
  kind: string;
  parentTaskId?: string | null;
  childTaskId?: string | null;
  mailboxMessageId?: string | null;
  senderId?: string | null;
};

export async function persistOrchestrationPrompt(
  input: PersistOrchestrationPromptInput,
): Promise<string> {
  const messageId = input.messageId ?? ulid();
  await projectDataService.persistMessage(
    input.env,
    input.projectId,
    input.chatSessionId,
    'user',
    input.content,
    {
      source: input.source,
      kind: input.kind,
      parentTaskId: input.parentTaskId ?? null,
      childTaskId: input.childTaskId ?? null,
      mailboxMessageId: input.mailboxMessageId ?? null,
      senderId: input.senderId ?? null,
    },
    messageId,
  );
  return messageId;
}
