export type ChatRole = 'user' | 'assistant';

export interface PrototypePerson {
  id: string;
  name: string;
  initials: string;
  color: string;
}

export interface ChatMessageMock {
  id: string;
  role: ChatRole;
  author: PrototypePerson;
  body: string;
  time: string;
  noteCount: number;
}

export interface CommentMock {
  id: string;
  author: PrototypePerson;
  body: string;
  time: string;
  status?: 'open' | 'resolved' | 'stale';
}

export interface LibraryAnchorMock {
  id: string;
  label: string;
  quote: string;
  commentCount: number;
  status?: 'open' | 'resolved' | 'stale';
  comments: CommentMock[];
}

export const PEOPLE = {
  owner: { id: 'owner', name: 'Raphaël', initials: 'RM', color: '#16a34a' },
  maya: { id: 'maya', name: 'Maya Chen', initials: 'MC', color: '#7c3aed' },
  jordan: { id: 'jordan', name: 'Jordan Lee', initials: 'JL', color: '#0ea5e9' },
  agent: { id: 'agent', name: 'Codex', initials: 'CX', color: '#334155' },
} satisfies Record<string, PrototypePerson>;

export const CHAT_MESSAGES: ChatMessageMock[] = [
  {
    id: 'message-1',
    role: 'user',
    author: PEOPLE.owner,
    body: 'Can you map the rollout risks for comments in shared chats and tell me what we should prototype first?',
    time: '18:42',
    noteCount: 1,
  },
  {
    id: 'message-2',
    role: 'assistant',
    author: PEOPLE.agent,
    body: 'The highest-risk interaction is the handoff between a collaborator leaving context and the session owner choosing what reaches the agent. I would prototype that review step before designing notifications or resolution workflows.\n\nFor Library files, start with Markdown selection anchors and make replacement or stale-anchor behavior visible from day one.',
    time: '18:43',
    noteCount: 2,
  },
  {
    id: 'message-3',
    role: 'user',
    author: PEOPLE.owner,
    body: 'Good. Make the distinction between human notes and prompts impossible to miss, especially on mobile.',
    time: '18:44',
    noteCount: 0,
  },
];

export const MESSAGE_NOTES: Record<string, CommentMock[]> = {
  'message-1': [
    {
      id: 'note-1',
      author: PEOPLE.jordan,
      body: 'The support team already uses the phrase “side note” for this. “Collaborator note” is clearer in product copy, but we may want to test both.',
      time: '2 min ago',
      status: 'open',
    },
  ],
  'message-2': [
    {
      id: 'note-2',
      author: PEOPLE.maya,
      body: 'One constraint from the existing multiplayer work: collaborators can watch a streaming turn, but only the session owner can send the next prompt.',
      time: '1 min ago',
      status: 'open',
    },
    {
      id: 'note-3',
      author: PEOPLE.jordan,
      body: 'Could the review tray show exactly what will be attached to the next prompt? I would be nervous if “include” silently rewrote the transcript.',
      time: 'Just now',
      status: 'open',
    },
  ],
};

export const CHECKPOINT_NOTES: CommentMock[] = [
  {
    id: 'checkpoint-1',
    author: PEOPLE.maya,
    body: 'I checked the customer interview notes: people want comments visible to the whole project, not private reviewer notes.',
    time: 'Just now',
    status: 'open',
  },
  {
    id: 'checkpoint-2',
    author: PEOPLE.jordan,
    body: 'Please ask the agent to cover the case where a comment lands while its response is still streaming.',
    time: 'Just now',
    status: 'open',
  },
];

export const MARKDOWN_CONTENT = `# Multiplayer comments rollout

Comments should help collaborators contribute context without impersonating the person who owns the agent session.

## First release

The first release should make the handoff explicit: collaborators leave notes, the session owner reviews them, and only selected notes are attached to the next agent turn.

### Design principles

- Human notes stay visually distinct from prompts and agent responses.
- Everyone in the project can read the same threads.
- Anchors survive ordinary edits when possible and become visibly stale when they cannot be matched safely.
- Mobile is the primary review experience.

## Open question

Should resolved notes disappear from the default view, or remain collapsed near their original anchor?`;

export const CODE_CONTENT = `export async function assembleNextTurn(input: {
  ownerMessage: string;
  includedNoteIds: string[];
}) {
  const notes = await getIncludedNotes(input.includedNoteIds);

  return {
    transcriptMessage: input.ownerMessage,
    collaboratorContext: notes.map(snapshotNote),
  };
}`;

export const LIBRARY_ANCHORS: LibraryAnchorMock[] = [
  {
    id: 'anchor-handoff',
    label: 'Paragraph under First release',
    quote:
      'collaborators leave notes, the session owner reviews them, and only selected notes are attached to the next agent turn.',
    commentCount: 3,
    status: 'open',
    comments: [
      {
        id: 'file-comment-1',
        author: PEOPLE.maya,
        body: 'This sequence is right. Could we name the owner action “Include with next message” rather than just “Include”?',
        time: '12 min ago',
        status: 'open',
      },
      {
        id: 'file-comment-2',
        author: PEOPLE.owner,
        body: 'Yes — that makes the scope much clearer on mobile.',
        time: '9 min ago',
        status: 'open',
      },
      {
        id: 'file-comment-3',
        author: PEOPLE.jordan,
        body: 'We should also say the note is a snapshot. Editing the original after the prompt is sent cannot change agent context retroactively.',
        time: '4 min ago',
        status: 'open',
      },
    ],
  },
  {
    id: 'anchor-stale',
    label: 'Design principles, item 3',
    quote: 'Anchors survive ordinary edits when possible',
    commentCount: 1,
    status: 'stale',
    comments: [
      {
        id: 'file-comment-stale',
        author: PEOPLE.jordan,
        body: 'This text moved after the file was replaced. I think this is the best recovery treatment: keep the quote, label it stale, and let a user re-anchor it.',
        time: 'Yesterday',
        status: 'stale',
      },
    ],
  },
];

export const CODE_ANCHOR: LibraryAnchorMock = {
  id: 'anchor-code',
  label: 'Lines 7–9',
  quote: 'collaboratorContext: notes.map(snapshotNote)',
  commentCount: 2,
  status: 'open',
  comments: [
    {
      id: 'code-comment-1',
      author: PEOPLE.maya,
      body: 'Can this preserve author identity and the original anchor label in addition to the note body?',
      time: '7 min ago',
      status: 'open',
    },
    {
      id: 'code-comment-2',
      author: PEOPLE.owner,
      body: 'Yes. The snapshot needs enough provenance for the agent and the audit trail.',
      time: '5 min ago',
      status: 'open',
    },
  ],
};

const STRESS_TEXT =
  'A very long comment used to stress wrapping in a narrow rail. It includes a deliberately long reference https://example.com/projects/comments/research/anchors/this-segment-is-intentionally-unreasonably-long-and-must-wrap-cleanly and continues with enough detail to exceed five hundred characters. The user is explaining that a replaced Markdown document might retain the same heading while the selected paragraph moves, changes punctuation, gains Unicode like Καλημέρα, こんにちは, مرحباً, and includes literal text such as <script>alert("not executable")</script> &amp; other entities. The interface must keep every action reachable without pushing the close button, status chip, or composer beyond the viewport edge.';

export const MANY_COMMENTS: CommentMock[] = Array.from({ length: 32 }, (_, index) => ({
  id: `stress-${index + 1}`,
  author: index % 2 === 0 ? PEOPLE.maya : PEOPLE.jordan,
  body:
    index === 0
      ? STRESS_TEXT
      : `Stress-test reply ${index + 1}: ${index % 3 === 0 ? '🔎 Unicode + narrow layout check.' : 'Short realistic follow-up.'}`,
  time: `${index + 1} min ago`,
  status: index % 9 === 0 ? 'stale' : index % 5 === 0 ? 'resolved' : 'open',
}));

export const EMPTY_COMMENTS: CommentMock[] = [];

export const ERROR_MESSAGE =
  'Comments could not refresh. The file and previously loaded comments are still available.';
