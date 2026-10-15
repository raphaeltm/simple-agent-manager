import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAttachments } from '../../../src/pages/project-chat/useAttachments';

const mocks = vi.hoisted(() => ({ request: vi.fn(), upload: vi.fn() }));
vi.mock('../../../src/lib/api', () => ({
  requestAttachmentUpload: mocks.request,
  uploadAttachmentToR2: mocks.upload,
}));

describe('staged attachment identity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it('removing an earlier file cannot redirect a later upload completion', async () => {
    const finish: Array<() => void> = [];
    mocks.request.mockImplementation(async (_project, name) => ({
      uploadId: name,
      uploadUrl: name,
    }));
    mocks.upload.mockImplementation(() => new Promise<void>((resolve) => finish.push(resolve)));
    const setError = vi.fn();
    const { result } = renderHook(() => useAttachments('project', setError));
    act(() =>
      result.current.handleChatFilesSelected([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')])
    );
    await waitFor(() => expect(finish).toHaveLength(2));
    act(() => result.current.handleRemoveChatAttachment(0));
    await act(async () => {
      finish[0]!();
      finish[1]!();
    });
    expect(result.current.chatAttachments).toHaveLength(1);
    expect(result.current.chatAttachments[0]).toMatchObject({
      status: 'complete',
      ref: { filename: 'b.txt' },
    });
  });
  it('clearing a submitted queue prevents a late completion from attaching to the next message', async () => {
    let finish!: () => void;
    mocks.request.mockResolvedValue({ uploadId: 'first', uploadUrl: 'first' });
    mocks.upload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const setError = vi.fn();
    const { result } = renderHook(() => useAttachments('project', setError));
    act(() => result.current.handleChatFilesSelected([new File(['a'], 'a.txt')]));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => result.current.clearAttachments());
    await act(async () => finish());
    expect(result.current.chatAttachments).toEqual([]);
  });
});
