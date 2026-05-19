import { SamApiClient, SamApiError } from '../src/client.js';

describe('SamApiClient', () => {
  it('submits tasks with auth cookie and compact payload', async () => {
    const calls: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init) calls.push(init);
      return jsonResponse({ taskId: 'task_1', sessionId: 'sess_1', branchName: 'sam/demo', status: 'queued' }, 202);
    });
    const client = new SamApiClient({
      apiUrl: 'https://api.example.com',
      sessionCookie: 'better-auth.session_token=secret',
    }, fetchMock);

    const response = await client.submitTask('project_1', 'Build the CLI', {
      mode: 'conversation',
      vmSize: 'small',
    });

    expect(response.taskId).toBe('task_1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/projects/project_1/tasks/submit',
      expect.objectContaining({ method: 'POST' })
    );
    expect(calls).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'better-auth.session_token=secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          message: 'Build the CLI',
          taskMode: 'conversation',
          vmSize: 'small',
        }),
      }),
    ]);
  });

  it('formats API errors without exposing auth details', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'APPROVAL_REQUIRED',
      message: 'Your account is pending admin approval',
    }, 403));
    const client = new SamApiClient({
      apiUrl: 'https://api.example.com',
      sessionCookie: 'secret-cookie',
    }, fetchMock);

    await expect(client.getTaskStatus('project_1', 'task_1')).rejects.toEqual(
      new SamApiError(403, 'APPROVAL_REQUIRED', 'Your account is pending admin approval')
    );
  });

  it('sends chat follow-up prompts to the session prompt route', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }, 200));
    const client = new SamApiClient({
      apiUrl: 'https://api.example.com',
      sessionCookie: 'cookie=value',
    }, fetchMock);

    await client.sendPrompt('project_1', 'session_1', 'Follow up');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/projects/project_1/sessions/session_1/prompt',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'Follow up' }),
      })
    );
  });
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
