export interface MockPolicyProfile {
  name: string;
  scope: string;
  summary: string;
  status: 'inherit' | 'restricted' | 'approval';
  permissions: Array<{ name: string; level: string; note: string }>;
}

export interface MockPolicyEvent {
  time: string;
  actor: string;
  action: string;
  decision: 'allowed' | 'denied' | 'scoped';
  detail: string;
}

export const mockPolicyAreas = [
  {
    name: 'GitHub CLI',
    state: 'Active',
    note: 'Scoped installation tokens for git and gh commands.',
  },
  { name: 'MCP tools', state: 'Planned', note: 'Future tools/list and tools/call evaluator.' },
  {
    name: 'Session grants',
    state: 'Planned',
    note: 'Temporary escalation with audit-backed expiry.',
  },
  {
    name: 'Audit log',
    state: 'Preview',
    note: 'Decision records from token mint and refresh paths.',
  },
] as const;

export const mockProfiles: MockPolicyProfile[] = [
  {
    name: 'Default conversational profile',
    scope: 'Project default',
    summary: 'Inherits the installation permissions selected during GitHub App setup.',
    status: 'inherit',
    permissions: [
      {
        name: 'Code contents',
        level: 'Installation',
        note: 'Clone, fetch, push follow the app grant.',
      },
      {
        name: 'Pull requests',
        level: 'Installation',
        note: 'PR creation and review commands are unchanged.',
      },
      {
        name: 'Issues',
        level: 'Installation',
        note: 'Issue commands work if the app has the grant.',
      },
    ],
  },
  {
    name: 'Release engineer with very long profile name that should wrap cleanly on mobile screens',
    scope: 'Agent profile override',
    summary: 'Can push release branches and update PRs, but cannot read or mutate issues.',
    status: 'restricted',
    permissions: [
      { name: 'Code contents', level: 'Read and write', note: 'Required for release branch push.' },
      { name: 'Pull requests', level: 'Read and write', note: 'Can open and update release PRs.' },
      { name: 'Issues', level: 'No access', note: 'GitHub token omits issues permission.' },
      { name: 'Actions', level: 'Read', note: 'Can inspect CI state without rerunning jobs.' },
      { name: 'Packages', level: 'Read and write', note: 'Can publish devcontainer cache images.' },
    ],
  },
  {
    name: 'Support triage trigger',
    scope: 'Trigger constraint',
    summary: 'Future MCP policy example: read incoming issues, ask approval before replying.',
    status: 'approval',
    permissions: [
      { name: 'Issue metadata', level: 'Read', note: 'Allowed only for matching labels.' },
      {
        name: 'Email reply',
        level: 'Approval required',
        note: 'Recipient must be an original thread participant.',
      },
    ],
  },
  {
    name: 'No override configured yet',
    scope: 'Empty state example',
    summary: 'Shows how a project reads when every profile inherits the app installation grant.',
    status: 'inherit',
    permissions: [],
  },
  {
    name: 'Security review - special chars <script>alert("policy")</script> & unicode',
    scope: 'Long-form stress data',
    summary:
      'This deliberately long summary checks wrapping for URLs like https://example.invalid/repositories/org/repo/issues/1234567890?labels=security-review&policy=github-cli and text that includes quotes, ampersands, and unusual punctuation without overflowing narrow screens.',
    status: 'restricted',
    permissions: [
      { name: 'Code contents', level: 'Read', note: 'Can inspect files but cannot push.' },
      { name: 'Pull requests', level: 'Read', note: 'Can inspect review state only.' },
      { name: 'Issues', level: 'No access', note: 'Issue reads and writes are denied.' },
      { name: 'Actions', level: 'No access', note: 'Workflow state is hidden.' },
      { name: 'Packages', level: 'No access', note: 'Package publishing is blocked.' },
    ],
  },
];

export const mockEvents: MockPolicyEvent[] = [
  {
    time: '09:14:03',
    actor: 'Release engineer',
    action: 'gh pr create',
    decision: 'scoped',
    detail:
      'Installation token minted for repository_id=918273 and permissions contents:write, pull_requests:write, packages:write.',
  },
  {
    time: '09:16:41',
    actor: 'Release engineer',
    action: 'gh issue list',
    decision: 'denied',
    detail: 'GitHub returned 403 because the scoped installation token omitted issues permission.',
  },
  {
    time: '09:18:22',
    actor: 'Default conversational profile',
    action: 'git push',
    decision: 'allowed',
    detail:
      'Profile inherited the installation token behavior. No SAM platform policy narrowing applied.',
  },
  ...Array.from({ length: 30 }, (_, index) => ({
    time: `10:${String(index).padStart(2, '0')}:07`,
    actor: index % 2 === 0 ? 'Release engineer' : 'Security review',
    action: index % 3 === 0 ? 'gh pr view' : index % 3 === 1 ? 'gh issue list' : 'git fetch',
    decision: (index % 3 === 0 ? 'allowed' : index % 3 === 1 ? 'denied' : 'scoped') as
      | 'allowed'
      | 'denied'
      | 'scoped',
    detail:
      index % 3 === 1
        ? 'Denied because the profile token omits issues permission; payload included label="needs & review" safely as text.'
        : 'Decision record generated from the same policy resolver that would run before token refresh.',
  })),
];
