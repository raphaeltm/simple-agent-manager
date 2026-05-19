import type {
  ApiErrorBody,
  CliConfig,
  SessionPromptResponse,
  SubmitTaskResponse,
  TaskStatusResponse,
  TaskSubmitOptions,
} from './types.js';

export class SamApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SamApiError';
  }
}

export class SamApiClient {
  constructor(
    private readonly config: CliConfig,
    private readonly fetchFn: typeof fetch
  ) {}

  async submitTask(
    projectId: string,
    message: string,
    options: TaskSubmitOptions
  ): Promise<SubmitTaskResponse> {
    return this.request<SubmitTaskResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/submit`,
      {
        method: 'POST',
        body: {
          message,
          ...compact({
            agentProfileId: options.agentProfileId,
            agentType: options.agentType,
            contextSummary: options.contextSummary,
            devcontainerConfigName: options.devcontainerConfigName,
            nodeId: options.nodeId,
            parentTaskId: options.parentTaskId,
            provider: options.provider,
            taskMode: options.mode,
            vmLocation: options.vmLocation,
            vmSize: options.vmSize,
            workspaceProfile: options.workspaceProfile,
          }),
        },
      }
    );
  }

  async getTaskStatus(projectId: string, taskId: string): Promise<TaskStatusResponse> {
    return this.request<TaskStatusResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET' }
    );
  }

  async sendPrompt(
    projectId: string,
    sessionId: string,
    content: string
  ): Promise<SessionPromptResponse> {
    return this.request<SessionPromptResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: 'POST',
        body: { content },
      }
    );
  }

  async getSession(projectId: string, sessionId: string): Promise<unknown> {
    return this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' }
    );
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const response = await this.fetchFn(`${this.config.apiUrl}${path}`, {
      method: options.method,
      headers: {
        Accept: 'application/json',
        Cookie: this.config.sessionCookie,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const body = await parseJson(response);
    if (!response.ok) {
      const errorBody = toApiErrorBody(body);
      throw new SamApiError(
        response.status,
        errorBody.error ?? 'HTTP_ERROR',
        errorBody.message ?? `SAM API request failed with ${response.status}`
      );
    }
    return body as T;
  }
}

interface RequestOptions {
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined)
  );
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new SamApiError(response.status, 'INVALID_JSON', 'SAM API returned invalid JSON');
    }
    return { message: text };
  }
}

function toApiErrorBody(value: unknown): ApiErrorBody {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    error: typeof record.error === 'string' ? record.error : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
  };
}
