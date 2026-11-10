import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_PREVIEW_LINE_MAX_CHARS,
  ATTACHMENT_PREVIEW_TEXT_MAX_BYTES,
  describeAttachment,
  looksLikeText,
} from '../../../src/components/project-chat/attachments/attachment-kind';
import { prepareTextPreview } from '../../../src/components/project-chat/attachments/AttachmentTextPreview';
import {
  ProjectChatComposer,
  type ProjectChatComposerAttachment,
} from '../../../src/components/project-chat/ProjectChatComposer';

// Cloudflare behaviour: every platform service present (absent case: platform-capabilities-ui.test.tsx).
vi.mock('../../../src/hooks/usePlatformCapabilities', () => ({
  usePlatformCapabilities: () => ({
    speechToText: true,
    textToSpeech: true,
    guidedCredentialSetup: true,
    analytics: true,
    workerLogSearch: true,
    artifacts: true,
    emailSending: true,
  }),
}));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return { ...actual, VoiceButton: () => null };
});

Element.prototype.scrollIntoView = vi.fn();

// jsdom has no object URLs; record which File each URL was made from so tests can prove the
// preview reads the local file.
const urlFiles = new Map<string, Blob>();
let urlSeq = 0;
const createObjectURL = vi.fn((blob: Blob) => {
  const url = `blob:local/${urlSeq++}`;
  urlFiles.set(url, blob);
  return url;
});
const revokeObjectURL = vi.fn((url: string) => urlFiles.delete(url));
const fetchSpy = vi.fn();

beforeEach(() => {
  urlFiles.clear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  fetchSpy.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const png = () =>
  new File([new Uint8Array([137, 80, 78, 71])], 'CleanShot.png', { type: 'image/png' });
const paste = (text: string) =>
  new File([text], 'pasted-1794057131479.txt', { type: 'text/plain' });

function complete(file: File, id: string): ProjectChatComposerAttachment {
  return { id, file, progress: 100, status: 'complete' };
}

/** The composer with real attachment state, wired the way FollowUpInput and ChatInput wire it. */
function Harness({
  initial,
  onChange,
}: {
  initial: ProjectChatComposerAttachment[];
  onChange?: (value: string) => void;
}) {
  const [attachments, setAttachments] = useState(initial);
  const [value, setValue] = useState('');
  return (
    <ProjectChatComposer
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      onSend={vi.fn()}
      sending={false}
      placeholder="Message"
      transcribeApiUrl="/transcribe"
      attachments={attachments}
      onRemoveAttachment={(index) => setAttachments((prev) => prev.filter((_, i) => i !== index))}
      onFilesSelected={vi.fn()}
      focusOnMount={false}
    />
  );
}

function list() {
  return screen.getByRole('list', { name: /attachment/ });
}

describe('composer attachment cards', () => {
  it('shows an image thumbnail drawn from the local File, with no network read', async () => {
    const file = png();
    render(<Harness initial={[complete(file, 'a')]} />);
    const thumb = await waitFor(() => {
      const img = list().querySelector('img');
      expect(img).not.toBeNull();
      return img!;
    });
    expect(urlFiles.get(thumb.getAttribute('src')!)).toBe(file);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('labels a long paste by its first line and line count', async () => {
    render(<Harness initial={[complete(paste('\n  first real line\nsecond\nthird\n'), 'p')]} />);
    const card = await screen.findByRole('button', {
      name: /^Preview Pasted text, Pasted text, 4 lines/,
    });
    expect(within(card).getByText('first real line')).toBeInTheDocument();
    expect(within(card).getByText(/Pasted · 4 lines/)).toBeInTheDocument();
  });

  it('gives other files a typed badge and size', () => {
    const zip = new File([new Uint8Array(2048)], 'snapshot.zip', { type: 'application/zip' });
    render(<Harness initial={[complete(zip, 'z')]} />);
    const card = screen.getByRole('button', { name: /^Preview snapshot\.zip, ZIP · Archive/ });
    expect(within(card).getByText('ZIP · 2.0 KB')).toBeInTheDocument();
  });

  it('removes from the corner button without opening the preview', () => {
    render(<Harness initial={[complete(png(), 'a'), complete(paste('x'), 'b')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove CleanShot.png' }));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('revokes the thumbnail URL when its attachment is removed', async () => {
    render(<Harness initial={[complete(png(), 'a')]} />);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const url = createObjectURL.mock.results[0]!.value as string;
    fireEvent.click(screen.getByRole('button', { name: 'Remove CleanShot.png' }));
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });
});

describe('attachment preview dialog', () => {
  it('opens the local image from the card and closes with Escape, returning focus', async () => {
    const file = png();
    render(<Harness initial={[complete(file, 'a')]} />);
    const card = screen.getByRole('button', { name: /^Preview CleanShot\.png/ });
    card.focus();
    fireEvent.click(card);
    const dialog = screen.getByRole('dialog', { name: 'CleanShot.png' });
    // jsdom never decodes, so the viewer keeps the <img> visually hidden; find it by alt text.
    const img = await within(dialog).findByAltText('CleanShot.png');
    expect(urlFiles.get(img.getAttribute('src')!)).toBe(file);
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(card);
  });

  it('plays a video attachment from the local file', async () => {
    const clip = new File([new Uint8Array(16)], 'screen.mp4', { type: 'video/mp4' });
    render(<Harness initial={[complete(clip, 'v')]} />);
    fireEvent.click(screen.getByRole('button', { name: /^Preview screen\.mp4/ }));
    const video = await screen.findByTestId('video-preview');
    expect(urlFiles.get(video.getAttribute('src')!)).toBe(clip);
    expect(video).toHaveAttribute('controls');
  });

  it('shows numbered lines of a paste and moves it back into the message', async () => {
    const text = 'alpha\nbeta\ngamma';
    const onChange = vi.fn();
    render(<Harness initial={[complete(paste(text), 'p')]} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Preview Pasted text/ }));
    const body = await screen.findByTestId('attachment-text-preview');
    expect(within(body).getByText('beta')).toBeInTheDocument();
    expect(within(body).getByText('3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit in message' }));
    expect(onChange).toHaveBeenLastCalledWith(text);
    expect(screen.queryByRole('list', { name: /attachment/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pages with the arrow keys and stays open on the neighbour after Remove', async () => {
    render(
      <Harness
        initial={[
          complete(png(), 'a'),
          complete(new File(['b'], 'notes.md', { type: 'text/markdown' }), 'b'),
          complete(new File([new Uint8Array(4)], 'data.zip', { type: 'application/zip' }), 'c'),
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Preview CleanShot\.png/ }));
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    // Focus lands on the dialog when it opens; that is where the key goes.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'notes.md' })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove notes.md' })
    );
    expect(screen.getByRole('dialog', { name: 'data.zip' })).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    // The row behind the modal is aria-hidden, so count its items directly.
    expect(screen.getByTestId('composer-attachments').querySelectorAll('li')).toHaveLength(2);
  });

  it('keeps arrow keys for the focused text region instead of paging away', async () => {
    render(
      <Harness
        initial={[
          complete(paste('one\ntwo'), 'p'),
          complete(new File([new Uint8Array(4)], 'data.zip', { type: 'application/zip' }), 'z'),
        ]}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Preview Pasted text/ }));
    const region = await screen.findByRole('region', { name: 'File contents' });
    region.focus();
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    // Control: on the dialog chrome the same key pages.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it("names a paste's remove button by its first line", async () => {
    render(<Harness initial={[complete(paste('alpha line\nbeta'), 'p')]} />);
    expect(
      await screen.findByRole('button', { name: 'Remove Pasted text “alpha line”' })
    ).toBeInTheDocument();
  });

  it('previews a failed, over-limit file from the local copy and says why it failed', async () => {
    const big = png();
    render(
      <Harness
        initial={[
          {
            id: 'x',
            file: big,
            progress: 0,
            status: 'error',
            error: 'Larger than the 50 MB limit',
          },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /failed: Larger than the 50 MB limit/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Larger than the 50 MB limit. Remove it to send your message.'
    );
    // jsdom never decodes, so the viewer keeps the <img> visually hidden; find it by alt text.
    const img = await within(dialog).findByAltText('CleanShot.png');
    expect(urlFiles.get(img.getAttribute('src')!)).toBe(big);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

describe('text preview preparation', () => {
  it('keeps a single over-long line instead of dropping it as partial', () => {
    const oneLine = '{"a":1}'.repeat(60_000);
    const prepared = prepareTextPreview(
      oneLine.slice(0, ATTACHMENT_PREVIEW_TEXT_MAX_BYTES),
      oneLine.length
    );
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0]).toHaveLength(ATTACHMENT_PREVIEW_LINE_MAX_CHARS);
    expect(prepared.bytesTruncated).toBe(true);
    expect(prepared.lineClipped).toBe(true);
  });

  it('drops the partial last line of a truncated multi-line read', () => {
    const prepared = prepareTextPreview('one\ntwo\nthr', ATTACHMENT_PREVIEW_TEXT_MAX_BYTES + 1);
    expect(prepared.lines).toEqual(['one', 'two']);
  });

  it('shows a whole small file, ignoring a trailing newline', () => {
    expect(prepareTextPreview('one\ntwo\n', 8)).toMatchObject({
      lines: ['one', 'two'],
      bytesTruncated: false,
      linesHidden: false,
    });
  });
});

describe('describeAttachment', () => {
  it.each([
    ['pasted-123.txt', 'text/plain', 'text', 'Pasted text'],
    ['diagram.svg', 'image/svg+xml', 'image', 'SVG · Image'],
    ['IMG_1.HEIC', 'image/heic', 'other', 'HEIC · Image'],
    ['clip.mov', 'video/quicktime', 'video', 'MOV · Video'],
    ['budget.xlsx', '', 'other', 'XLSX · Spreadsheet'],
    ['costs.csv', 'text/csv', 'text', 'CSV · Spreadsheet'],
    ['useThing.ts', '', 'text', 'TS · Code'],
    ['firmware.bin', 'application/octet-stream', 'other', 'BIN · File'],
    ['file.constructor', '', 'other', 'CONSTRUCTOR · File'],
  ])('%s (%s) → %s', (name, type, kind, typeLabel) => {
    const info = describeAttachment(new File(['x'], name, { type }));
    expect(info.kind).toBe(kind);
    expect(info.typeLabel).toBe(typeLabel);
  });

  it('upgrades an extensionless file to text once its head sniffs as text', () => {
    const dockerfile = new File(['FROM node:22\n'], 'Dockerfile');
    expect(describeAttachment(dockerfile).kind).toBe('other');
    expect(looksLikeText('FROM node:22\n')).toBe(true);
    expect(describeAttachment(dockerfile, true).kind).toBe('text');
    expect(looksLikeText('\u007fELF\u0002\u0001\u0000\u0000')).toBe(false);
  });

  it('sniffs an extensionless text file into a text card', async () => {
    render(
      <Harness initial={[complete(new File(['FROM node:22\nRUN x\n'], 'Dockerfile'), 'd')]} />
    );
    await act(async () => {});
    expect(
      await screen.findByRole('button', { name: /^Preview Dockerfile, Text, 2 lines/ })
    ).toBeInTheDocument();
  });
});
