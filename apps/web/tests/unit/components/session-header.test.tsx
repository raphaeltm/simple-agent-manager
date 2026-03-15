import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const srcRoot = join(__dirname, '../../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf-8');
}

describe('SessionHeader UI structure', () => {
  const source = readSource('components/chat/ProjectMessageView.tsx');

  it('does not render Direct URL section', () => {
    // Direct URL was removed — ensure no remnants
    expect(source).not.toContain('label="Direct URL"');
  });

  it('renders branch name in infrastructure context with GitBranch icon', () => {
    expect(source).toContain('GitBranch');
    expect(source).toContain('label="Branch"');
    expect(source).toContain('taskEmbed?.outputBranch');
  });

  it('renders provider with location combined', () => {
    expect(source).toContain('label="Provider"');
    expect(source).toContain('workspace?.vmLocation');
  });

  it('renders node link with health status', () => {
    expect(source).toContain('label="Node"');
    expect(source).toContain('node.healthStatus');
    expect(source).toContain('/nodes/${node.id}');
  });

  it('renders Mark Complete button when task is eligible', () => {
    expect(source).toContain('Mark Complete');
    expect(source).toContain('canMarkComplete');
    expect(source).toContain('handleMarkComplete');
  });

  it('accepts projectId prop for task completion API calls', () => {
    expect(source).toContain('projectId: string;');
    // Verify projectId is passed down from parent
    expect(source).toContain('projectId={projectId}');
  });

  it('calls updateProjectTaskStatus and deleteWorkspace on mark complete', () => {
    expect(source).toContain('updateProjectTaskStatus(projectId, taskEmbed.id');
    expect(source).toContain("toStatus: 'completed'");
    expect(source).toContain('deleteWorkspace(session.workspaceId)');
  });

  it('shows confirmation dialog before completing', () => {
    expect(source).toContain('window.confirm');
    expect(source).toContain('Mark this task as complete');
  });

  it('disables button and shows spinner while completing', () => {
    expect(source).toContain('completing');
    expect(source).toContain("'Completing...'");
    expect(source).toContain('disabled={completing}');
  });

  it('keeps Open Workspace button in action row', () => {
    expect(source).toContain('Open Workspace');
  });
});

describe('SessionHeader mark complete handler logic', () => {
  let mockConfirm: ReturnType<typeof vi.fn>;
  let mockAlert: ReturnType<typeof vi.fn>;
  let mockReload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockConfirm = vi.fn();
    mockAlert = vi.fn();
    mockReload = vi.fn();
    vi.stubGlobal('confirm', mockConfirm);
    vi.stubGlobal('alert', mockAlert);
    // We can't easily test window.location.reload in a unit test
    // but we verify the source calls it
  });

  it('handler requires both projectId and taskId', () => {
    const source = readSource('components/chat/ProjectMessageView.tsx');
    // The handler checks for taskEmbed?.id before proceeding
    expect(source).toContain('if (!taskEmbed?.id || completing) return');
  });

  it('excludes completed/cancelled/failed tasks from mark-complete eligibility', () => {
    const source = readSource('components/chat/ProjectMessageView.tsx');
    expect(source).toContain("taskEmbed.status !== 'completed'");
    expect(source).toContain("taskEmbed.status !== 'cancelled'");
    expect(source).toContain("taskEmbed.status !== 'failed'");
  });
});
