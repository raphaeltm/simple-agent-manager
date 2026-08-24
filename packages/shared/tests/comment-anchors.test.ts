/**
 * The `CommentAnchor` discriminated union is the seam that lets message comments
 * and library-file comments share presentation while keeping separate storage.
 *
 * These tests exist because an earlier cut of library file commenting forged
 * `{ kind: 'message', messageId: fileId }` to satisfy a message-typed prop,
 * defeating the union at exactly the boundary it exists to protect. Narrowing on
 * `kind` must stay the only way to reach the anchor-specific fields.
 */
import { describe, expect, it } from 'vitest';

import type {
  CommentAnchor,
  LibraryFileCommentAnchor,
  MessageCommentAnchor,
} from '../src/types/comments';
import { COMMENT_ANCHOR_KINDS } from '../src/types/comments';

const messageAnchor: MessageCommentAnchor = {
  kind: 'message',
  messageId: 'msg-1',
  quote: 'quoted from a chat message',
};

const fileAnchor: LibraryFileCommentAnchor = {
  kind: 'library_file',
  fileId: 'file-1',
  quote: 'quoted from a markdown file',
};

/** Mirrors how the DO and the UI actually consume an anchor. */
function describeAnchor(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case 'message':
      return `message:${anchor.messageId}`;
    case 'library_file':
      return `library_file:${anchor.fileId}`;
  }
}

describe('CommentAnchor discriminated union', () => {
  it('narrows to the message variant on kind', () => {
    expect(describeAnchor(messageAnchor)).toBe('message:msg-1');
  });

  it('narrows to the library-file variant on kind', () => {
    expect(describeAnchor(fileAnchor)).toBe('library_file:file-1');
  });

  it('exposes only its own identifier field per variant', () => {
    // A file anchor carries no messageId and a message anchor no fileId. If the
    // two ever collapsed into one optional-everything shape, the storage-level
    // separation they represent would be unenforceable.
    expect('messageId' in fileAnchor).toBe(false);
    expect('fileId' in messageAnchor).toBe(false);
  });

  it('models an absent quote as null on both variants', () => {
    const withoutQuote: CommentAnchor[] = [
      { kind: 'message', messageId: 'msg-2', quote: null },
      { kind: 'library_file', fileId: 'file-2', quote: null },
    ];
    expect(withoutQuote.map((a) => a.quote)).toEqual([null, null]);
  });

  it('enumerates exactly the anchor kinds the union admits', () => {
    // Guards against a kind being added to the runtime list without a
    // corresponding variant (or vice versa), which would let an unhandled kind
    // reach `describeAnchor`-style switches at runtime.
    const unionKinds: CommentAnchor['kind'][] = ['message', 'library_file'];
    expect([...COMMENT_ANCHOR_KINDS].sort()).toEqual([...unionKinds].sort());
  });
});
