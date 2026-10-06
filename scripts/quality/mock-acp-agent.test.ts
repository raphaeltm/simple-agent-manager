import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('deterministic ACP permission fixture', () => {
  it('emits reversed safety options and completes with the exact selected option', () => {
    const fixture = resolve(process.cwd(), 'scripts/e2e/workspace-mock/mock-acp-agent.sh');
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: 'permission-reversed' }] },
      },
      {
        jsonrpc: '2.0',
        id: 9001,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');

    const output = execFileSync('bash', [fixture], {
      encoding: 'utf8',
      input: `${input}\n`,
      env: { ...process.env, ACP_LOG_FILE: '/tmp/sam-mock-acp-agent-test.log' },
    })
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);

    const request = output.find((entry) => entry.method === 'session/request_permission');
    expect(request?.params.options).toEqual([
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    ]);
    expect(JSON.stringify(request)).toContain('fixture-raw-input-must-not-leak');

    const permissionResult = output.find(
      (entry) => entry.method === 'session/update' && entry.params?.update?.content?.text
    );
    expect(permissionResult?.params.update.content.text).toBe('PERMISSION:allow');
    expect(output).toContainEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  });
});
