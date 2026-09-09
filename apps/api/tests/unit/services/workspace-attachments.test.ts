import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({ fetchNodeAgent: vi.fn(), signTerminalToken: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: mocks.fetchNodeAgent }));
vi.mock('../../../src/services/jwt', () => ({ signTerminalToken: mocks.signTerminalToken }));
import { transferWorkspaceAttachments } from '../../../src/services/workspace-attachments';

const attachment = {
  uploadId: 'upload-1',
  filename: 'debug.txt',
  size: 4,
  contentType: 'text/plain',
};
function fixture() {
  const get = vi.fn(async () => ({
    body: new Blob(['test']).stream(),
    httpMetadata: { contentType: 'text/plain' },
  }));
  const remove = vi.fn(async () => undefined);
  return {
    env: { BASE_DOMAIN: 'example.test', R2: { get, delete: remove } } as unknown as Env,
    get,
    remove,
  };
}
describe('runtime-aware workspace attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signTerminalToken.mockResolvedValue({ token: 'private-test-token' });
    mocks.fetchNodeAgent.mockResolvedValue(new Response('{}'));
  });
  it.each(['https', 'http'])('honors configured %s transport while using owner-scoped uploads', async (protocol) => {
    const { env, get, remove } = fixture();
    env.VM_AGENT_PROTOCOL = protocol;
    const beforeTransfer = vi.fn();
    await transferWorkspaceAttachments({
      env,
      userId: 'owner',
      nodeId: 'instant-node',
      workspaceId: 'workspace',
      attachments: [attachment],
      beforeTransfer,
    });
    expect(get).toHaveBeenCalledWith('temp-uploads/owner/upload-1/debug.txt');
    expect(mocks.signTerminalToken).toHaveBeenCalledWith('owner', 'workspace', env);
    const [, , url, request, , controls] = mocks.fetchNodeAgent.mock.calls[0]!;
    expect(new URL(url).protocol).toBe(protocol + ':');
    expect(new URL(url).pathname).toBe('/workspaces/workspace/files/upload');
    expect(controls.beforeExternalMutation).toBe(beforeTransfer);
    expect(request.body.get('destination')).toBeNull();
    expect(await request.body.get('files').text()).toBe('test');
    expect(remove).toHaveBeenCalledWith('temp-uploads/owner/upload-1/debug.txt');
  });
  it('preserves uploaded data and redacts remote failure bodies on rejection', async () => {
    const { env, remove } = fixture();
    mocks.fetchNodeAgent.mockResolvedValue(new Response('canary-secret', { status: 403 }));
    await expect(
      transferWorkspaceAttachments({
        env,
        userId: 'owner',
        nodeId: 'node',
        workspaceId: 'workspace',
        attachments: [attachment],
      })
    ).rejects.toMatchObject({
      message: 'Attachment transfer failed for debug.txt: 403',
      permanent: true,
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
