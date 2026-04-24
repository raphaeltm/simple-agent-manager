import type { DetectedPort, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { useState } from 'react';

import type { ChatSessionResponse } from '../lib/api';
import { SessionHeader } from '../components/project-message-view/SessionHeader';
import type { SessionState } from '../components/project-message-view/types';

// Helper to create partial mock objects without listing every required field
function mockWorkspace(data: Partial<WorkspaceResponse> & { id: string; name: string; status: string; vmSize: string; vmLocation: string }): WorkspaceResponse {
  return { repository: '', branch: 'main', vmIp: null, lastActivityAt: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...data } as WorkspaceResponse;
}
function mockNode(data: Partial<NodeResponse> & { id: string; name: string; status: string }): NodeResponse {
  return { vmSize: 'small', vmLocation: 'fsn1', ipAddress: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...data } as NodeResponse;
}
function mockPort(data: Omit<DetectedPort, 'detectedAt'>): DetectedPort {
  return { ...data, detectedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Mock data — various session scenarios
// ---------------------------------------------------------------------------

const NOW = Date.now();

const MOCK_SESSIONS: Array<{
  label: string;
  session: ChatSessionResponse;
  sessionState: SessionState;
  idleCountdownMs: number | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: DetectedPort[];
}> = [
  {
    label: 'Active task with workspace, node, ports, and ACP session',
    session: {
      id: 'f900b8a6-9380-49a7-b415-0b83d091a7fb',
      workspaceId: '01KPXR2WWAV96CWYER5Z5PXT0C',
      taskId: '01KPXR2SJJT310MCSV5Y04MRY7',
      topic: 'Fix authentication flow and update OAuth redirect handling',
      status: 'active',
      messageCount: 142,
      startedAt: NOW - 23 * 60 * 1000, // 23 min ago
      endedAt: null,
      createdAt: NOW - 24 * 60 * 1000,
      agentSessionId: '01KPXR3ABC123DEF456GHI789',
      task: {
        id: '01KPXR2SJJT310MCSV5Y04MRY7',
        status: 'in_progress',
        executionStep: 'agent_session',
        errorMessage: null,
        outputBranch: 'sam/fix-oauth-redirect-01kpxr',
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: null,
      },
    },
    sessionState: 'active',
    idleCountdownMs: null,
    workspace: mockWorkspace({
      id: '01KPXR2WWAV96CWYER5Z5PXT0C',
      name: 'ws-01KPXR2WWAV96CWYER5Z5PXT0C',
      displayName: 'fix-oauth-redirect',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'fsn1',
      workspaceProfile: 'full',
      nodeId: '01KPXR1ABC123NODE456',
      projectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
      chatSessionId: 'f900b8a6-9380-49a7-b415-0b83d091a7fb',
    }),
    node: mockNode({
      id: '01KPXR1ABC123NODE456',
      name: 'sam-node-fsn1-01',
      status: 'running',
      cloudProvider: 'hetzner',
      healthStatus: 'healthy',
      lastHeartbeatAt: new Date(NOW - 15000).toISOString(),
    }),
    detectedPorts: [
      mockPort({ port: 5173, url: 'https://ws-01KPXR2WWAV--5173.sammy.party', label: 'Vite', address: '127.0.0.1' }),
      mockPort({ port: 8787, url: 'https://ws-01KPXR2WWAV--8787.sammy.party', label: 'Wrangler', address: '127.0.0.1' }),
    ],
  },
  {
    label: 'Idle session with cleanup countdown',
    session: {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      workspaceId: '01KPXQJZ0E9F11S2XRSER2BXCX',
      taskId: '01KPXQEWYBT6R5H55YPJDC310P',
      topic: 'Research best practices for WebSocket reconnection strategies',
      status: 'active',
      messageCount: 87,
      startedAt: NOW - 45 * 60 * 1000,
      endedAt: null,
      createdAt: NOW - 46 * 60 * 1000,
      agentCompletedAt: NOW - 12 * 60 * 1000,
      isIdle: true,
      agentSessionId: '01KPXQ4DEF789ABC012JKL345',
      cleanupAt: NOW + 18 * 60 * 1000,
      task: {
        id: '01KPXQEWYBT6R5H55YPJDC310P',
        status: 'in_progress',
        executionStep: 'awaiting_followup',
        errorMessage: null,
        outputBranch: 'sam/websocket-reconnect-01kpxq',
        outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/812',
        outputSummary: null,
        finalizedAt: null,
      },
    },
    sessionState: 'idle',
    idleCountdownMs: 18 * 60 * 1000,
    workspace: mockWorkspace({
      id: '01KPXQJZ0E9F11S2XRSER2BXCX',
      name: 'ws-01KPXQJZ0E9F11S2XRSER2BXCX',
      displayName: 'websocket-reconnect',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'nbg1',
      workspaceProfile: 'lightweight',
      nodeId: '01KPXQ1NODE789DEF',
      projectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
      chatSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    }),
    node: mockNode({
      id: '01KPXQ1NODE789DEF',
      name: 'sam-node-nbg1-03',
      status: 'running',
      cloudProvider: 'hetzner',
      healthStatus: 'healthy',
      lastHeartbeatAt: new Date(NOW - 30000).toISOString(),
    }),
    detectedPorts: [],
  },
  {
    label: 'Completed task (stopped session) with PR',
    session: {
      id: '7247885a-8802-4656-8cda-1283b38ac3d1',
      workspaceId: null,
      taskId: '01KPY0H7H367AKWFY425SWYWYR',
      topic: 'Implement notification batching and deduplication',
      status: 'stopped',
      messageCount: 554,
      startedAt: NOW - 4 * 3600 * 1000,
      endedAt: NOW - 3.5 * 3600 * 1000,
      createdAt: NOW - 4 * 3600 * 1000,
      isTerminated: true,
      task: {
        id: '01KPY0H7H367AKWFY425SWYWYR',
        status: 'completed',
        executionStep: null,
        errorMessage: null,
        outputBranch: 'sam/notification-batching-01kpy0',
        outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/803',
        outputSummary: 'Implemented notification batching with 5-minute windows and 60-second deduplication. Added progress notifications from update_task_status.',
        finalizedAt: new Date(NOW - 3.5 * 3600 * 1000).toISOString(),
      },
    },
    sessionState: 'terminated',
    idleCountdownMs: null,
    workspace: null,
    node: null,
    detectedPorts: [],
  },
  {
    label: 'Failed task with error message',
    session: {
      id: '9cde7eac-d00c-4315-b024-daa74408139a',
      workspaceId: null,
      taskId: '01KPXQATSMWAN0TYF860P8M3M9',
      topic: 'Investigate Codex offline status with debug package',
      status: 'stopped',
      messageCount: 55,
      startedAt: NOW - 2 * 3600 * 1000,
      endedAt: NOW - 1.8 * 3600 * 1000,
      createdAt: NOW - 2 * 3600 * 1000,
      isTerminated: true,
      task: {
        id: '01KPXQATSMWAN0TYF860P8M3M9',
        status: 'failed',
        executionStep: 'node_provisioning',
        errorMessage: 'Node provisioning timed out after 180s — no healthy node available in fsn1',
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: new Date(NOW - 1.8 * 3600 * 1000).toISOString(),
      },
    },
    sessionState: 'terminated',
    idleCountdownMs: null,
    workspace: null,
    node: null,
    detectedPorts: [],
  },
  {
    label: 'Provisioning — node selection phase',
    session: {
      id: 'bbb11111-2222-3333-4444-555566667777',
      workspaceId: null,
      taskId: '01KPZZZZ1111222233334444',
      topic: 'Build search indexing for project knowledge graph',
      status: 'active',
      messageCount: 0,
      startedAt: NOW - 45 * 1000,
      endedAt: null,
      createdAt: NOW - 50 * 1000,
      task: {
        id: '01KPZZZZ1111222233334444',
        status: 'in_progress',
        executionStep: 'node_selection',
        errorMessage: null,
        outputBranch: null,
        outputPrUrl: null,
        outputSummary: null,
        finalizedAt: null,
      },
    },
    sessionState: 'active',
    idleCountdownMs: null,
    workspace: null,
    node: null,
    detectedPorts: [],
  },
  {
    label: 'Conversation mode (no task) — just a chat session',
    session: {
      id: 'ccc99999-8888-7777-6666-555544443333',
      workspaceId: '01KPCONV0WORKSPACE123',
      taskId: null,
      topic: 'Brainstorm DAG-based task orchestration architecture',
      status: 'active',
      messageCount: 23,
      startedAt: NOW - 10 * 60 * 1000,
      endedAt: null,
      createdAt: NOW - 11 * 60 * 1000,
      agentSessionId: '01KPCONV0ACP456SESSIONID',
    },
    sessionState: 'active',
    idleCountdownMs: null,
    workspace: mockWorkspace({
      id: '01KPCONV0WORKSPACE123',
      name: 'ws-01KPCONV0WORKSPACE123',
      displayName: 'brainstorm-dag',
      status: 'running',
      vmSize: 'small',
      vmLocation: 'fsn1',
      workspaceProfile: 'lightweight',
      nodeId: '01KPCONV0NODE789',
      projectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
      chatSessionId: 'ccc99999-8888-7777-6666-555544443333',
    }),
    node: null,
    detectedPorts: [
      mockPort({ port: 3000, url: 'https://ws-01KPCONV0--3000.sammy.party', label: 'Dev server', address: '127.0.0.1' }),
    ],
  },
];

// ---------------------------------------------------------------------------
// Prototype page
// ---------------------------------------------------------------------------

export function SessionHeaderPrototype() {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const scenario = MOCK_SESSIONS[selectedIdx];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--sam-color-bg-primary, #0a0a0a)', color: 'var(--sam-color-fg-primary, #e5e5e5)' }}>
      {/* Page header */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--sam-color-border-default, #333)' }}>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Session Header Prototype</h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--sam-color-fg-muted, #888)' }}>
          Click the chevron to expand. Click any reference ID to copy. All data is mock.
        </p>
      </div>

      {/* Scenario picker */}
      <div style={{ padding: '12px 24px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {MOCK_SESSIONS.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelectedIdx(i)}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: selectedIdx === i ? 600 : 400,
              borderRadius: '6px',
              border: `1px solid ${selectedIdx === i ? 'var(--sam-color-accent-primary, #3b82f6)' : 'var(--sam-color-border-default, #333)'}`,
              background: selectedIdx === i ? 'var(--sam-color-accent-tint, rgba(59,130,246,0.1))' : 'transparent',
              color: selectedIdx === i ? 'var(--sam-color-accent-primary, #3b82f6)' : 'var(--sam-color-fg-muted, #888)',
              cursor: 'pointer',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Simulated chat container */}
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '0 16px' }}>
        <div style={{
          border: '1px solid var(--sam-color-border-default, #333)',
          borderRadius: '8px',
          overflow: 'hidden',
          background: 'var(--sam-color-surface-default, #141414)',
        }}>
          {/* The actual session header component */}
          {scenario && (
            <SessionHeader
              projectId="01KHRJGANBBWGDY1NZ0KVF0D4J"
              session={scenario.session}
              sessionState={scenario.sessionState}
              loading={false}
              idleCountdownMs={scenario.idleCountdownMs}
              taskEmbed={scenario.session.task ?? null}
              workspace={scenario.workspace}
              node={scenario.node}
              detectedPorts={scenario.detectedPorts}
              onSessionMutated={() => alert('Session mutated callback fired')}
              onOpenFiles={() => alert('Open files')}
              onOpenGit={() => alert('Open git')}
              onRetry={() => alert('Retry')}
              onFork={() => alert('Fork')}
            />
          )}

          {/* Fake chat messages to give context */}
          <div style={{ padding: '24px 16px', minHeight: '200px' }}>
            <div style={{
              padding: '12px 16px',
              borderRadius: '8px',
              background: 'var(--sam-color-accent-tint, rgba(59,130,246,0.06))',
              fontSize: '13px',
              lineHeight: '1.5',
              color: 'var(--sam-color-fg-secondary, #aaa)',
              marginBottom: '12px',
            }}>
              (Chat messages would appear here. This is a visual prototype of the session header above.)
            </div>
            <div style={{
              padding: '12px 16px',
              borderRadius: '8px',
              background: 'var(--sam-color-surface-hover, #1a1a1a)',
              fontSize: '12px',
              fontFamily: 'monospace',
              color: 'var(--sam-color-fg-muted, #888)',
            }}>
              <div>Session: {scenario?.session.id}</div>
              <div>Task: {scenario?.session.task?.id ?? '(none)'}</div>
              <div>Workspace: {scenario?.session.workspaceId ?? '(none)'}</div>
              <div>State: {scenario?.sessionState}</div>
              <div>Status: {scenario?.session.status}</div>
            </div>
          </div>
        </div>
      </div>

      {/* All scenarios stacked — for comparing at once */}
      <div style={{ padding: '24px', borderTop: '1px solid var(--sam-color-border-default, #333)', marginTop: '24px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--sam-color-fg-muted, #888)' }}>
          All scenarios (stacked)
        </h2>
        <div style={{ maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {MOCK_SESSIONS.map((s, i) => (
            <div key={i} style={{
              border: '1px solid var(--sam-color-border-default, #333)',
              borderRadius: '8px',
              overflow: 'hidden',
              background: 'var(--sam-color-surface-default, #141414)',
            }}>
              <div style={{ padding: '4px 12px', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--sam-color-fg-muted, #666)', borderBottom: '1px solid var(--sam-color-border-default, #333)' }}>
                {s.label}
              </div>
              <SessionHeader
                projectId="01KHRJGANBBWGDY1NZ0KVF0D4J"
                session={s.session}
                sessionState={s.sessionState}
                loading={false}
                idleCountdownMs={s.idleCountdownMs}
                taskEmbed={s.session.task ?? null}
                workspace={s.workspace}
                node={s.node}
                detectedPorts={s.detectedPorts}
                onRetry={() => {}}
                onFork={() => {}}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
