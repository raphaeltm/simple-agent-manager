import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const srcRoot = join(__dirname, '../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf-8');
}

describe('SessionSidebar', () => {
  const source = readSource('components/chat/SessionSidebar.tsx');

  it('exports SessionSidebar as named export', () => {
    expect(source).toContain('export const SessionSidebar');
  });

  it('accepts sessions, selectedSessionId, loading, and onSelect props', () => {
    expect(source).toContain('sessions: ChatSessionResponse[]');
    expect(source).toContain('selectedSessionId: string | null');
    expect(source).toContain('loading: boolean');
    expect(source).toContain('onSelect: (sessionId: string) => void');
  });

  it('renders active session indicator (green dot)', () => {
    expect(source).toContain('borderRadius: \'50%\'');
    expect(source).toContain('var(--sam-color-success)');
  });

  it('shows selected session highlight with left border', () => {
    expect(source).toContain('var(--sam-color-accent-primary)');
    expect(source).toContain('borderLeft');
  });

  it('renders session topic or fallback ID', () => {
    expect(source).toContain('session.topic');
    expect(source).toContain('session.id.slice(0, 8)');
  });

  it('shows message count for each session', () => {
    expect(source).toContain('session.messageCount');
  });

  it('renders empty state when no sessions', () => {
    // Updated in 022: SessionSidebar uses EmptyState component
    expect(source).toContain('EmptyState');
  });

  it('renders loading spinner when loading', () => {
    expect(source).toContain('Spinner');
  });

  it('formats relative time for timestamps', () => {
    expect(source).toContain('formatRelativeTime');
    expect(source).toContain('Just now');
    expect(source).toContain('m ago');
    expect(source).toContain('h ago');
    expect(source).toContain('d ago');
  });

  it('uses session state colors and labels', () => {
    expect(source).toContain('STATE_COLORS');
    expect(source).toContain('STATE_LABELS');
    expect(source).toContain('getSessionState');
  });
});

describe('ProjectMessageView', () => {
  const source = readSource('components/chat/ProjectMessageView.tsx');

  it('exports ProjectMessageView as named export', () => {
    expect(source).toContain('export const ProjectMessageView');
  });

  it('accepts projectId and sessionId props', () => {
    expect(source).toContain('projectId: string');
    expect(source).toContain('sessionId: string');
  });

  it('loads session data on mount', () => {
    expect(source).toContain('getChatSession(projectId, sessionId)');
    expect(source).toContain('useEffect');
  });

  it('renders message bubbles with role-based styling', () => {
    expect(source).toContain('MessageBubble');
    expect(source).toContain('roleStyles');
    expect(source).toContain('user:');
    expect(source).toContain('assistant:');
    expect(source).toContain('system:');
    expect(source).toContain('tool:');
  });

  it('establishes WebSocket for real-time updates on active sessions', () => {
    expect(source).toContain('new WebSocket(wsUrl)');
    expect(source).toContain('message.new');
    expect(source).toContain('session.stopped');
  });

  it('has polling fallback for WebSocket failures', () => {
    expect(source).toContain('setInterval');
    expect(source).toContain('ACTIVE_POLL_MS');
  });

  it('deduplicates messages by id', () => {
    expect(source).toContain('prev.some((m) => m.id === newMsg.id)');
  });

  it('supports loading earlier messages (pagination)', () => {
    expect(source).toContain('Load earlier messages');
    expect(source).toContain('loadMore');
    expect(source).toContain('hasMore');
  });

  it('auto-scrolls to bottom on new messages', () => {
    expect(source).toContain('messagesEndRef');
    expect(source).toContain('scrollIntoView');
  });

  it('renders session header with derived state', () => {
    expect(source).toContain('deriveSessionState');
    expect(source).toContain('session.status');
  });

  it('shows Open Workspace button for active sessions', () => {
    expect(source).toContain('Open Workspace');
    expect(source).toContain('session.workspaceId');
  });

  it('displays tool metadata in expandable details', () => {
    expect(source).toContain('toolMetadata');
    expect(source).toContain('<details');
    expect(source).toContain('Tool metadata');
  });

  it('cleans up WebSocket and polling on unmount', () => {
    expect(source).toContain('ws?.close()');
    expect(source).toContain('clearInterval(pollInterval)');
  });
});

describe('SplitButton', () => {
  const source = readSource('components/ui/SplitButton.tsx');

  it('exports SplitButton and SplitButtonProps', () => {
    expect(source).toContain('export const SplitButton');
    expect(source).toContain('export interface SplitButtonProps');
    expect(source).toContain('export interface SplitButtonOption');
  });

  it('accepts required props', () => {
    expect(source).toContain('primaryLabel: string');
    expect(source).toContain('onPrimaryAction: () => void');
    expect(source).toContain('options: SplitButtonOption[]');
  });

  it('supports disabled and loading states', () => {
    expect(source).toContain('disabled?: boolean');
    expect(source).toContain('loading?: boolean');
    expect(source).toContain('not-allowed');
  });

  it('handles click-outside to close dropdown', () => {
    expect(source).toContain('handleClickOutside');
    expect(source).toContain('mousedown');
  });

  it('handles Escape key to close dropdown', () => {
    expect(source).toContain('handleKeyDown');
    expect(source).toContain('Escape');
  });

  it('renders chevron dropdown toggle', () => {
    expect(source).toContain('More options');
    expect(source).toContain('svg');
  });

  it('closes dropdown on option selection', () => {
    expect(source).toContain('option.onClick()');
    expect(source).toContain('setOpen(false)');
  });

  it('cleans up event listeners', () => {
    expect(source).toContain('removeEventListener');
  });
});

describe('ProjectChat page', () => {
  const source = readSource('pages/ProjectChat.tsx');

  it('exports ProjectChat function', () => {
    expect(source).toContain('export function ProjectChat');
  });

  it('uses SessionSidebar component', () => {
    expect(source).toContain('SessionSidebar');
    expect(source).toContain('from \'../components/chat/SessionSidebar\'');
  });

  it('uses ProjectMessageView component', () => {
    expect(source).toContain('ProjectMessageView');
    expect(source).toContain('from \'../components/chat/ProjectMessageView\'');
  });

  it('reads sessionId from route params', () => {
    expect(source).toContain('useParams');
    expect(source).toContain('sessionId');
  });

  it('loads sessions list from API', () => {
    expect(source).toContain('listChatSessions(projectId');
  });

  it('auto-selects most recent session when none selected', () => {
    expect(source).toContain('!sessionId && sessions.length > 0');
    expect(source).toContain('sessions[0]');
    expect(source).toContain('replace: true');
  });

  it('renders split layout with sidebar and content', () => {
    expect(source).toContain('gridTemplateColumns');
    expect(source).toContain('280px 1fr');
  });

  it('navigates to session on selection', () => {
    expect(source).toContain('navigate(`/projects/${projectId}/chat/${');
  });

  it('uses ProjectContext for projectId', () => {
    expect(source).toContain('useProjectContext');
  });

  it('shows new chat prompt when no session selected', () => {
    expect(source).toContain('What do you want to build?');
  });

  it('shows description for new chat input', () => {
    expect(source).toContain('Describe the task and an agent will start working on it automatically');
  });
});

describe('Routing integration', () => {
  const appSource = readSource('App.tsx');
  const projectSource = readSource('pages/Project.tsx');

  it('imports ProjectChat in App.tsx', () => {
    expect(appSource).toContain('import { ProjectChat } from \'./pages/ProjectChat\'');
  });

  it('registers chat route without sessionId', () => {
    expect(appSource).toContain('<Route path="chat" element={<ProjectChat />} />');
  });

  it('registers chat route with sessionId', () => {
    expect(appSource).toContain('<Route path="chat/:sessionId" element={<ProjectChat />} />');
  });

  it('project page has no tab navigation (chat-first layout)', () => {
    // Tabs removed in 022 — chat is rendered directly via Outlet
    expect(projectSource).not.toContain("id: 'chat'");
    expect(projectSource).not.toContain("id: 'tasks'");
    expect(projectSource).not.toContain('tablist');
  });
});
