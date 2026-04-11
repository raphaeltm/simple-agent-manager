import type {
  CreateTriggerRequest,
  ListTriggerExecutionsResponse,
  ListTriggersResponse,
  TriggerExecutionStatus,
  TriggerResponse,
  UpdateTriggerRequest,
} from '@simple-agent-manager/shared';

import { request } from './client';

export async function listTriggers(
  projectId: string
): Promise<ListTriggersResponse> {
  return request<ListTriggersResponse>(
    `/api/projects/${projectId}/triggers`
  );
}

export async function getTrigger(
  projectId: string,
  triggerId: string
): Promise<TriggerResponse> {
  return request<TriggerResponse>(
    `/api/projects/${projectId}/triggers/${triggerId}`
  );
}

export async function createTrigger(
  projectId: string,
  data: CreateTriggerRequest
): Promise<TriggerResponse> {
  return request<TriggerResponse>(
    `/api/projects/${projectId}/triggers`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
}

export async function updateTrigger(
  projectId: string,
  triggerId: string,
  data: UpdateTriggerRequest
): Promise<TriggerResponse> {
  return request<TriggerResponse>(
    `/api/projects/${projectId}/triggers/${triggerId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    }
  );
}

export async function deleteTrigger(
  projectId: string,
  triggerId: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/api/projects/${projectId}/triggers/${triggerId}`,
    {
      method: 'DELETE',
    }
  );
}

export async function testTrigger(
  projectId: string,
  triggerId: string
): Promise<{ renderedPrompt: string }> {
  return request<{ renderedPrompt: string }>(
    `/api/projects/${projectId}/triggers/${triggerId}/test`,
    {
      method: 'POST',
    }
  );
}

export async function runTrigger(
  projectId: string,
  triggerId: string
): Promise<{ executionId: string; taskId: string }> {
  return request<{ executionId: string; taskId: string }>(
    `/api/projects/${projectId}/triggers/${triggerId}/run`,
    {
      method: 'POST',
    }
  );
}

export async function listTriggerExecutions(
  projectId: string,
  triggerId: string,
  params?: {
    limit?: number;
    offset?: number;
    status?: TriggerExecutionStatus;
  }
): Promise<ListTriggerExecutionsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.status) searchParams.set('status', params.status);

  const qs = searchParams.toString();
  return request<ListTriggerExecutionsResponse>(
    `/api/projects/${projectId}/triggers/${triggerId}/executions${qs ? `?${qs}` : ''}`
  );
}

export async function deleteExecution(
  projectId: string,
  triggerId: string,
  executionId: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/api/projects/${projectId}/triggers/${triggerId}/executions/${executionId}`,
    {
      method: 'DELETE',
    }
  );
}

export async function cleanupStuckExecutions(
  projectId: string,
  triggerId: string
): Promise<{ cleaned: number }> {
  return request<{ cleaned: number }>(
    `/api/projects/${projectId}/triggers/${triggerId}/executions/cleanup`,
    {
      method: 'POST',
    }
  );
}
