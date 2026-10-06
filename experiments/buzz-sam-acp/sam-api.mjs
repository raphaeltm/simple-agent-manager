import { safeDiagnostic } from './configuration.mjs';

class SamApiError extends Error {
  constructor(status, code, message) {
    super(`SAM API ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

function projectPath(projectId, ...segments) {
  const encoded = [projectId, ...segments].map((part) => encodeURIComponent(part));
  return `/api/projects/${encoded.join('/')}`;
}

export class SamApi {
  constructor(config) {
    this.config = config;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: this.config.sessionCookie,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(this.config.httpTimeoutMs),
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: safeDiagnostic(text, this.config.errorBodyLimit) };
      }
    }
    if (!response.ok) {
      throw new SamApiError(
        response.status,
        typeof payload.error === 'string' ? payload.error : 'HTTP_ERROR',
        safeDiagnostic(
          typeof payload.message === 'string' ? payload.message : response.statusText,
          this.config.errorBodyLimit
        )
      );
    }
    return payload;
  }

  submitConversation(message) {
    return this.request(projectPath(this.config.projectId, 'tasks', 'submit'), {
      method: 'POST',
      body: {
        message,
        taskMode: 'conversation',
        agentProfileId: this.config.agentProfileId,
      },
    });
  }

  sendPrompt(sessionId, content) {
    return this.request(projectPath(this.config.projectId, 'sessions', sessionId, 'prompt'), {
      method: 'POST',
      body: { content },
    });
  }

  cancel(sessionId) {
    return this.request(projectPath(this.config.projectId, 'sessions', sessionId, 'cancel'), {
      method: 'POST',
    });
  }

  getState(sessionId) {
    return this.request(projectPath(this.config.projectId, 'sessions', sessionId, 'state'));
  }

  getAssistantMessages(sessionId) {
    const query = new URLSearchParams({
      roles: 'assistant',
      limit: String(this.config.messageLimit),
      compact: 'false',
      order: 'desc',
    });
    return this.request(
      `${projectPath(this.config.projectId, 'sessions', sessionId, 'messages')}?${query}`
    );
  }

  getTask(taskId) {
    return this.request(projectPath(this.config.projectId, 'tasks', taskId));
  }
}
