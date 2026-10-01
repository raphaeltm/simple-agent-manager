import { describe, expect, it } from 'vitest';

import { classifyFailure } from '../../src/failure-classification';

describe('classifyFailure', () => {
  it('keeps an unclassified prompt failure generic even when step metadata looks like auth', () => {
    expect(classifyFailure('agent_prompt_failed', 'model_provider_credential_missing')).toMatchObject({
      code: 'agent-prompt-failed',
      label: 'Agent request failed',
    });
    expect(classifyFailure('Tool output: agent_prompt_failed').code).not.toBe('agent-prompt-failed');
  });
  it.each([
    ['cancelled', 'Task was cancelled by the user'],
    ['input-expired', 'Human input request expired after timeout'],
    ['capacity', 'Cloud provider reported server limit reached'],
    ['provider-overload', 'Provider returned 529 overloaded'],
    ['agent-install', 'Codex installation failed in the workspace'],
    ['provisioning', 'Workspace creation timed out'],
    ['prompt-timeout', 'ACP_TASK_PROMPT_TIMEOUT exceeded'],
    ['runtime-lost', 'Container died and runtime recovery exhausted'],
    ['agent-crash', 'Agent process crashed with SIGKILL'],
    ['stalled', 'Task stuck in running beyond watchdog threshold'],
    ['network', 'fetch failed with ECONNREFUSED'],
  ] as const)('classifies %s failures', (code, message) => {
    expect(classifyFailure(message)).toMatchObject({ code, retryable: true });
  });

  // Verbatim production reconciliation-sweep messages — the most common
  // terminal failure reasons observed in the live databases. Pinned so the
  // classifier can never regress them back to `unknown`.
  it.each([
    'Task runtime is conclusively gone after reconciliation grace (workspace_missing)',
    'Task runtime is no longer live after 240 minutes. Last liveness result: workspace_missing',
  ])('classifies real reconciliation-sweep messages as runtime-lost: %s', (message) => {
    expect(classifyFailure(message).code).toBe('runtime-lost');
  });

  /**
   * The exact text the stuck-task sweep and ProjectData idle cleanup record for a
   * benign supersession. New rows leave `tasks.error_message` NULL, so this only
   * classifies HISTORICAL rows — but those must read as a non-diagnosable
   * lifecycle outcome, not "Failed" (policies `a974b04f`, `486d1dd1`).
   */
  it('classifies a superseded-wake termination as a non-diagnosable cancellation', () => {
    const classification = classifyFailure(
      'Superseded by a later session wake; the conversation continued in a replacement ' +
        'task and has since ended.'
    );
    expect(classification.code).toBe('cancelled');
    expect(classification.diagnosable).toBe(false);
  });

  it('uses the optional execution step as classification evidence', () => {
    expect(classifyFailure('Operation failed', 'node provisioning timed out').code).toBe(
      'provisioning'
    );
  });

  it('uses first-match-wins ordering when a message matches multiple rules', () => {
    expect(classifyFailure('Task cancelled after provider returned 503 overloaded').code).toBe(
      'cancelled'
    );
    expect(classifyFailure('Unauthorized request was also rate limited with 429').code).toBe(
      'provider-overload'
    );
  });

  it.each([
    ['model-credential-missing', 'model_provider_credential_missing'],
    ['model-credential-rejected', 'model_provider_credential_rejected'],
    ['mcp-auth-required', 'mcp_endpoint_needs_auth'],
    ['unsupported-loopback-auth', 'unsupported_loopback_auth'],
    ['model-unavailable', 'model_unavailable'],
  ] as const)('separates %s from other auth failures', (code, message) => {
    expect(classifyFailure(message).code).toBe(code);
  });

  it.each([
    'Provider HTTP 400: bad request',
    'agent_key_fetch: Failed to fetch credential for openai-codex — backend timeout',
    'MCP tool failed for a network error',
    'The agent mentioned an unauthorized file while working',
    'Sign-in cancelled by the user',
    'MCP OAuth loopback callback required at http://localhost:1234',
    'agent_key_fetch: no credential configured for openai-codex',
  ])('does not prescribe credential changes for %s', (message) => {
    expect(classifyFailure(message).code).not.toMatch(/model-credential|mcp-auth-required/);
  });

  it.each([
    ['provider_overloaded', 'provider-overload'],
    ['network_error', 'network'],
    ['agent_crash', 'agent-crash'],
  ] as const)('keeps safe non-auth reason %s diagnosable', (message, code) => {
    expect(classifyFailure(message).code).toBe(code);
  });

  it('requires an exact structural code instead of promoting wrapper fields', () => {
    const canary = 'sk-secret-canary-12345';
    const result = classifyFailure(`mcp_endpoint_needs_auth url=https://evil.example/${canary} schema=${canary}`);
    expect(result.code).not.toBe('mcp-auth-required');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(JSON.stringify(result)).not.toContain('schema=');
  });

  it.each([
    'https://evil.example/model_provider_credential_missing',
    'Provider HTTP 400 url=https://evil.example/unsupported_model',
    'Provider HTTP 400 schema=model_unavailable',
    'Provider HTTP 400 unsupported_model with ChatGPT account',
    'API Error 400: model is not supported with this account',
    'Assistant said mcp_endpoint_needs_auth in its answer',
    'Tool output: model_provider_credential_rejected',
    'MCP service returned HTTP 401 invalid authentication',
    'API Error: 401 invalid authentication',
    'Tool output: unauthorized',
    'model_provider_credential_missing schema=spoof',
    'model_provider_credential_rejected message=spoof',
    'mcp_endpoint_needs_auth url=https://evil.example',
    'unsupported_loopback_auth message=spoof',
  ])('does not turn untrusted metadata or conversation prose into auth guidance: %s', (message) => {
    expect(classifyFailure(message).code).not.toMatch(/model-credential|mcp-auth-required|model-unavailable/);
  });

  it.each([
    ['https://example.test/callback?error=unauthorized', 'running'],
    ['schema={"error":"invalid token"}', 'running'],
    ['Provider HTTP 401 invalid authentication', 'running'],
    ['agent_prompt_failed', 'unauthorized'],
    ['Authentication failed: token expired', 'running'],
  ])('does not infer credentials from untrusted message or step: %s / %s', (message, step) => {
    const result = classifyFailure(message, step);
    expect(result.code).not.toMatch(/credential|mcp-auth-required/);
    expect(result.guidance).not.toMatch(/credential|connect the agent|sign.in|login/i);
  });

  it.each([
    ['stopped_by_parent: Session stalled', 'cancelled'],
    ['Stopped by parent: No longer needed', 'cancelled'],
    ['Human input request expired after timeout', 'input-expired'],
  ] as const)('treats normal lifecycle outcome %s as non-diagnosable', (message, code) => {
    expect(classifyFailure(message)).toMatchObject({ code, diagnosable: false });
  });

  it.each([undefined, null, '', 'an entirely novel failure mode'])(
    'falls back to unknown for unclassified input %s',
    (message) => {
      expect(classifyFailure(message)).toEqual({
        code: 'unknown',
        label: 'Failed',
        explanation: 'The task failed for a reason SAM could not automatically classify.',
        guidance:
          'Read the error details below. Copy the debug report and paste it to an agent to investigate.',
        retryable: true,
        diagnosable: true,
      });
    }
  );
});
