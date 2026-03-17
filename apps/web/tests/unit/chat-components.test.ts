import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const srcRoot = join(__dirname, '../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf-8');
}

describe('ProjectChat session sidebar (inline)', () => {
  const source = readSource('pages/ProjectChat.tsx');

  it('renders session topic or fallback ID', () => {
    expect(source).toContain('session.topic');
    expect(source).toContain('session.id.slice(0, 8)');
  });

  it('shows message count for each session', () => {
    expect(source).toContain('session.messageCount');
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

  it('renders loading spinner when loading', () => {
    expect(source).toContain('Spinner');
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

  it('uses ACP components for message rendering', () => {
    expect(source).toContain('AcpMessageBubble');
    expect(source).toContain('AcpToolCallCard');
    expect(source).toContain('AcpThinkingBlock');
    expect(source).toContain('AcpConversationItemView');
  });

  it('uses useChatWebSocket hook for real-time updates (TDF-8)', () => {
    expect(source).toContain('useChatWebSocket');
    expect(source).toContain('connectionState');
    expect(source).toContain('onMessage');
    expect(source).toContain('onSessionStopped');
    expect(source).toContain('onCatchUp');
  });

  it('has polling fallback for WebSocket failures', () => {
    expect(source).toContain('setInterval');
    expect(source).toContain('ACTIVE_POLL_MS');
  });

  it('deduplicates messages via mergeMessages utility at all update paths', () => {
    expect(source).toContain("mergeMessages(prev, [msg], 'append')");
    expect(source).toContain("mergeMessages(prev, catchUpMessages, 'replace')");
    expect(source).toContain("mergeMessages(prev, data.messages, 'replace')");
    expect(source).toContain("mergeMessages(prev, data.messages, 'prepend')");
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

  it('converts DO messages to ConversationItem for unified rendering', () => {
    expect(source).toContain('chatMessagesToConversationItems');
    expect(source).toContain('ConversationItem');
  });

  it('uses agent session ID (ULID) for ACP WebSocket routing — never falls back to chat session ID', () => {
    // The ACP WebSocket must connect using the agent session ID from D1,
    // not the chat session ID, to avoid creating a duplicate session on the VM agent.
    // When agentSessionId is null, the ACP connection must be DISABLED — never
    // fall back to the chat session ID which would create a second ACP session.
    expect(source).toContain('session?.agentSessionId ?? null');
    expect(source).toContain('agentSessionId !== null');
    expect(source).toContain('sessionId: agentSessionId ?? sessionId');
  });

  it('cleans up polling on unmount', () => {
    expect(source).toContain('clearInterval(pollInterval)');
  });

  it('shows connection status banner (TDF-8)', () => {
    expect(source).toContain('ConnectionBanner');
    expect(source).toContain('connectionState');
    expect(source).toContain('Reconnecting');
    expect(source).toContain('Disconnected');
  });

  it('shows idle timer countdown (TDF-8)', () => {
    expect(source).toContain('idleCountdownMs');
    expect(source).toContain('formatCountdown');
    expect(source).toContain('Cleanup in');
  });

  it('displays task error and summary regardless of session state (TDF-8)', () => {
    expect(source).toContain('taskEmbed?.errorMessage');
    expect(source).toContain('taskEmbed?.outputSummary');
    expect(source).toContain('Task failed:');
    expect(source).toContain('TruncatedSummary');
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

  it('renders inline session sidebar with SessionItem component', () => {
    expect(source).toContain('SessionItem');
    expect(source).toContain('w-72');
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

  it('defaults to new chat when no session selected', () => {
    expect(source).toContain('showNewChatInput');
    expect(source).toContain('What do you want to build?');
  });

  it('renders flex layout with sidebar and content', () => {
    expect(source).toContain('flex flex-1 min-h-0');
    expect(source).toContain('w-72 shrink-0');
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
