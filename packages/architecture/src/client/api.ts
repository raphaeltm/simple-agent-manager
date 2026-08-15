import type { ElementDetails } from '../queries';
import type { SourceRef } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import type { SourceReadResult } from '../types';
import type { ApiClient, ReplyInput, ThreadInput, ThreadMutationResult } from './types';

export function createApiClient(baseUrl = ''): ApiClient {
  return {
    loadModel: () => readJson<ViewerModel>(`${baseUrl}/api/model`),
    loadElement: async (id: string) => {
      const payload = await readJson<{ details: ElementDetails }>(
        `${baseUrl}/api/elements/${encodeURIComponent(id)}`
      );
      return payload.details;
    },
    loadSource: async (target: string, source: SourceRef, sourceIndex: number) => {
      const payload = await postJson<{ preview: SourceReadResult }>(
        `${baseUrl}/api/source-preview`,
        {
          target,
          sourceIndex,
          path: source.path,
        }
      );
      return payload.preview;
    },
    createThread: (input: ThreadInput) =>
      postJson<ThreadMutationResult>(`${baseUrl}/api/threads`, input),
    replyToThread: (threadId: string, input: ReplyInput) =>
      postJson<ThreadMutationResult>(
        `${baseUrl}/api/threads/${encodeURIComponent(threadId)}/replies`,
        input
      ),
  };
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  return parseResponse<T>(response);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    method: 'POST',
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message = extractErrorMessage(payload) ?? `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined;
  const error = payload.error;
  if (!error || typeof error !== 'object' || !('message' in error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}
