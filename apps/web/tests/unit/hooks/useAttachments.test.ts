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
  it('does not leak an in-flight upload into another session scope', async () => {
    let finish!: () => void;
    mocks.request.mockResolvedValue({ uploadId: 'old', uploadUrl: 'old' });
    mocks.upload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const setError = vi.fn();
    const { result, rerender } = renderHook(
      ({ scope }) => useAttachments('project', setError, scope),
      { initialProps: { scope: 'first' } }
    );
    act(() => result.current.handleChatFilesSelected([new File(['a'], 'a.txt')]));
    await waitFor(() => expect(finish).toBeDefined());
    rerender({ scope: 'second' });
    await act(async () => finish());
    expect(result.current.chatAttachments).toEqual([]);
  });
  it('uploads a file with unsafe characters under a sanitized name instead of rejecting it', async () => {
    mocks.request.mockResolvedValue({ uploadId: 'shot', uploadUrl: 'shot' });
    mocks.upload.mockResolvedValue(undefined);
    const setError = vi.fn();
    const { result } = renderHook(() => useAttachments('project', setError));
    const original = new File(['png'], 'CleanShot 2026-11-04 at 12.22.51@2x.png', {
      type: 'image/png',
    });
    act(() => result.current.handleChatFilesSelected([original]));
    await waitFor(() => expect(result.current.chatAttachments[0]?.status).toBe('complete'));
    expect(mocks.request).toHaveBeenCalledWith(
      'project',
      'CleanShot 2026-11-04 at 12.22.51_2x.png',
      3,
      'image/png'
    );
    expect(result.current.chatAttachments[0]).toMatchObject({
      file: { name: 'CleanShot 2026-11-04 at 12.22.51_2x.png' },
      ref: { filename: 'CleanShot 2026-11-04 at 12.22.51_2x.png', contentType: 'image/png' },
    });
    expect(setError).not.toHaveBeenCalledWith(expect.stringContaining('invalid characters'));
  });
});
