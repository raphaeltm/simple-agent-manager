/**
 * Glassmorphism prototype — unauthed route at /prototype/glass
 *
 * Renders real SessionHeader, TruncatedSummary, and AcpConversationItemView
 * components with mock data to demonstrate glass blur effects.
 * No API calls, no auth required.
 */
import type { DetectedPort, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import type { ConversationItem } from '@simple-agent-manager/acp-client';

import { useState } from 'react';

import type { ChatSessionResponse } from '../lib/api';
import { SessionHeader } from '../components/project-message-view/SessionHeader';
import { TruncatedSummary } from '../components/chat/TruncatedSummary';
import { AcpConversationItemView } from '../components/project-message-view/AcpConversationItemView';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_SESSION: ChatSessionResponse = {
  id: 'sess-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  workspaceId: 'ws-01ABCDEFGH1234567890ABCDEF',
  taskId: 'task-01XYZWVU9876543210FEDCBA',
  topic: 'Implement glassmorphism design system migration',
  status: 'active',
  messageCount: 42,
  startedAt: Date.now() - 45 * 60_000,
  endedAt: null,
  createdAt: Date.now() - 50 * 60_000,
  agentSessionId: 'acp-01MNOPQRST5678901234UVWX',
  agentType: 'claude-code',
  task: {
    id: 'task-01XYZWVU9876543210FEDCBA',
    status: 'in_progress',
    executionStep: 'agent_session',
    outputBranch: 'sam/glassmorphism-migration',
    outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/1044',
    outputSummary:
      'Migrated the entire UI to the glassmorphism design system with three glass tiers (chrome, surface, modal), green accent glow, and backdrop blur. Updated all panels, cards, and overlays to use the new tokens.',
    taskMode: 'task',
    agentProfileHint: 'default',
  },
};

const MOCK_WORKSPACE: WorkspaceResponse = {
  id: 'ws-01ABCDEFGH1234567890ABCDEF',
  name: 'glassmorphism-migration',
  displayName: 'glassmorphism-migration',
  status: 'running',
  vmSize: 'cx22',
  vmLocation: 'fsn1',
  nodeId: 'node-01NODEABC1234567890',
  workspaceProfile: null,
} as WorkspaceResponse;

const MOCK_NODE: NodeResponse = {
  id: 'node-01NODEABC1234567890',
  name: 'sam-fsn1-cx22-a1b2',
  status: 'active',
  healthStatus: 'healthy',
  cloudProvider: 'hetzner',
} as NodeResponse;

const MOCK_PORTS: DetectedPort[] = [
  { port: 5173, label: 'Vite Dev Server', url: 'https://ws-01ABCDEFGH--5173.example.com', address: '0.0.0.0' },
  { port: 8787, label: 'Wrangler', url: 'https://ws-01ABCDEFGH--8787.example.com', address: '127.0.0.1' },
];

const MOCK_SUMMARY =
  'Migrated the entire UI to the glassmorphism design system with three glass tiers (chrome, surface, modal), green accent glow effects, and backdrop blur filters. Updated all panels, cards, modals, and overlays to use the new CSS custom property tokens from packages/ui. Added accessibility fallbacks for prefers-reduced-transparency and browsers without backdrop-filter support.';

function makeMockConversation(): ConversationItem[] {
  const now = Date.now();
  return [
    {
      kind: 'user_message',
      id: 'msg-001',
      text: 'I want to migrate the entire UI to use glassmorphism. Start with the design tokens in packages/ui, then update all components.',
      timestamp: now - 40 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-002',
      text: "I'll start by defining the glassmorphism design tokens in `packages/ui/src/tokens/theme.css`. The system will have three glass tiers:\n\n- **Chrome** — navigation bars, headers (20px blur, 55% opacity)\n- **Surface** — cards, panels (24px blur, 65% opacity)\n- **Modal** — dialogs, overlays (24px blur, 55% opacity)\n\nEach tier gets backdrop-filter blur, semi-transparent backgrounds, and a green accent glow. Let me start with the CSS custom properties.",
      streaming: false,
      timestamp: now - 39 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-003',
      toolCallId: 'tc-001',
      title: 'Edit packages/ui/src/tokens/theme.css',
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          text: `@@ -45,6 +45,28 @@\n   --sam-color-success-tint: rgba(22, 163, 74, 0.1);\n \n+  /* Glass backdrop blur values */\n+  --sam-glass-blur-chrome: 20px;\n+  --sam-glass-blur-surface: 24px;\n+  --sam-glass-blur-modal: 24px;\n+\n+  /* Glass background colors */\n+  --sam-glass-bg-chrome: rgba(8, 15, 12, 0.55);\n+  --sam-glass-bg-surface: rgba(8, 15, 12, 0.65);\n+  --sam-glass-bg-modal: rgba(8, 15, 12, 0.55);\n+\n+  /* Glass saturate multiplier */\n+  --sam-glass-saturate: 1.35;\n+\n+  /* Edge glow */\n+  --sam-glass-glow-color: rgba(34, 197, 94, 0.5);\n+  --sam-glass-border-color: rgba(34, 197, 94, 0.12);\n`,
        },
      ],
      locations: [{ path: 'packages/ui/src/tokens/theme.css', line: 45 }],
      timestamp: now - 38 * 60_000,
    },
    {
      kind: 'thinking',
      id: 'msg-004',
      text: "Now I need to create the utility classes that consume these tokens. I'll add .glass-chrome, .glass-surface, and .glass-modal classes to the app's index.css with proper vendor prefixes and accessibility fallbacks.",
      active: false,
      timestamp: now - 37 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-005',
      toolCallId: 'tc-002',
      title: 'Edit apps/web/src/index.css',
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          text: `@@ -140,0 +141,30 @@\n+.glass-chrome {\n+  background-color: var(--sam-glass-bg-chrome);\n+  backdrop-filter: blur(var(--sam-glass-blur-chrome)) saturate(var(--sam-glass-saturate));\n+  -webkit-backdrop-filter: blur(var(--sam-glass-blur-chrome)) saturate(var(--sam-glass-saturate));\n+}\n+\n+.glass-surface {\n+  background-color: var(--sam-glass-bg-surface);\n+  backdrop-filter: blur(var(--sam-glass-blur-surface)) saturate(var(--sam-glass-saturate));\n+  -webkit-backdrop-filter: blur(var(--sam-glass-blur-surface)) saturate(var(--sam-glass-saturate));\n+}\n`,
        },
      ],
      locations: [{ path: 'apps/web/src/index.css', line: 141 }],
      timestamp: now - 36 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-006',
      text: "The glass utility classes are in place. Now I'll update the `SessionHeader` component to use `glass-chrome` instead of the old solid background. The header needs to be composited so backdrop-filter works through the stacking context.",
      streaming: false,
      timestamp: now - 35 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-007',
      toolCallId: 'tc-003',
      title: 'Edit apps/web/src/components/project-message-view/SessionHeader.tsx',
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          text: `@@ -198,3 +198,3 @@\n-      className="relative bg-surface-secondary border-b border-border-default shrink-0"\n+      className="relative glass-chrome glass-composited border-t-0 rounded-b-2xl shrink-0"\n`,
        },
      ],
      locations: [{ path: 'apps/web/src/components/project-message-view/SessionHeader.tsx', line: 198 }],
      timestamp: now - 34 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-008',
      text: "I've also added the green edge glow to the bottom of the session header using a pseudo-element with a radial gradient. The glow uses `rgba(34, 197, 94, 0.55)` — the SAM accent green at partial opacity — with a 2px blur to soften the edge.\n\nNow let me update the message bubbles to use the glass treatment too.",
      streaming: false,
      timestamp: now - 33 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-009',
      toolCallId: 'tc-004',
      title: 'Edit apps/web/src/index.css — glass message bubbles',
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          text: `@@ -170,0 +171,12 @@\n+.glass-msg-user {\n+  background: linear-gradient(135deg, rgba(22, 163, 74, 0.22), rgba(34, 197, 94, 0.1));\n+  border: 1px solid rgba(34, 197, 94, 0.22);\n+  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);\n+}\n+\n+.glass-msg-assistant {\n+  background: rgba(12, 20, 17, 0.65);\n+  border: 1px solid var(--sam-glass-border-color);\n+  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);\n+}\n`,
        },
      ],
      locations: [{ path: 'apps/web/src/index.css', line: 171 }],
      timestamp: now - 32 * 60_000,
    },
    {
      kind: 'user_message',
      id: 'msg-010',
      text: 'Looking good! Can we also add accessibility fallbacks for browsers that don\'t support backdrop-filter?',
      timestamp: now - 30 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-011',
      text: "Great call. I'll add two layers of fallbacks:\n\n1. **`@supports not (backdrop-filter: blur(1px))`** — solid opaque backgrounds for browsers without backdrop-filter\n2. **`@media (prefers-reduced-transparency: reduce)`** — a CSS variable flag `--sam-enable-blur` that multiplies all blur values to zero, giving users who prefer reduced transparency a solid experience without motion/blur\n\nThe blur calculations use `calc(var(--sam-enable-blur) * <blur-amount>)` so when `--sam-enable-blur` is set to `0`, all blurs become `0px` automatically.",
      streaming: false,
      timestamp: now - 29 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-012',
      toolCallId: 'tc-005',
      title: 'Read apps/web/src/index.css',
      toolKind: 'read',
      status: 'completed',
      content: [{ type: 'content', text: '(file contents — 245 lines)' }],
      locations: [{ path: 'apps/web/src/index.css' }],
      timestamp: now - 28 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-013',
      toolCallId: 'tc-006',
      title: 'Edit apps/web/src/index.css — accessibility fallbacks',
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          text: `@@ -240,0 +241,15 @@\n+@supports not (backdrop-filter: blur(1px)) {\n+  .glass-chrome { background-color: rgb(8, 15, 12); }\n+  .glass-surface { background-color: rgb(13, 24, 20); }\n+  .glass-modal  { background-color: rgb(8, 15, 12); }\n+}\n+\n+@media (prefers-reduced-transparency: reduce) {\n+  :root {\n+    --sam-enable-blur: 0;\n+  }\n+}\n`,
        },
      ],
      locations: [{ path: 'apps/web/src/index.css', line: 241 }],
      timestamp: now - 27 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-014',
      text: "The accessibility fallbacks are in place. The glassmorphism migration is looking solid. Here's a summary of what we've done:\n\n- Defined glass tokens in `theme.css` (blur, opacity, saturate, glow colors)\n- Created three glass tier utility classes (`.glass-chrome`, `.glass-surface`, `.glass-modal`)\n- Updated `SessionHeader` to use `glass-chrome` with green edge glow\n- Added glass message bubble styles (`.glass-msg-user`, `.glass-msg-assistant`)\n- Added `@supports` and `prefers-reduced-transparency` fallbacks\n\nAll components now use the design system tokens instead of hardcoded values. The green accent glow and backdrop blur create a cohesive dark glass aesthetic.",
      streaming: false,
      timestamp: now - 25 * 60_000,
    },
    // A few more messages to add scroll depth
    {
      kind: 'user_message',
      id: 'msg-015',
      text: 'Perfect. Now update the Card component in packages/ui to support a glass variant.',
      timestamp: now - 20 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-016',
      text: "I'll add a `glass` variant to the `Card` component that applies `glass-surface` plus the card glow animation on hover. The motion is subtle — a 1.01x scale with enhanced box shadow.",
      streaming: false,
      timestamp: now - 19 * 60_000,
    },
    {
      kind: 'tool_call',
      id: 'msg-017',
      toolCallId: 'tc-007',
      title: 'Edit packages/ui/src/components/Card.tsx',
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          text: `@@ -5,3 +5,4 @@ const variantClasses = {\n   default: 'bg-surface border border-border-default',\n+  glass: 'glass-surface glass-card-glow sam-glass-card-motion',\n };\n`,
        },
      ],
      locations: [{ path: 'packages/ui/src/components/Card.tsx', line: 5 }],
      timestamp: now - 18 * 60_000,
    },
    {
      kind: 'agent_message',
      id: 'msg-018',
      text: "The `Card` component now supports `variant=\"glass\"`. On hover, cards get a subtle scale transform (1.01x) with an enhanced green glow shadow. The glow respects `prefers-reduced-motion` — it's disabled entirely for users who prefer less motion.\n\nShall I continue with the modal and dialog components?",
      streaming: false,
      timestamp: now - 17 * 60_000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Glass summary panel — replaces the opaque TruncatedSummary with a
 * glass-surface treatment so backdrop-filter blur is visible.
 */
function GlassSummary({ summary }: { summary: string }) {
  return (
    <div
      className="glass-surface glass-composited px-4 py-2 rounded-xl border"
      style={{
        borderColor: 'rgba(34, 197, 94, 0.12)',
        /* Subtle green tint via gradient */
        background: 'linear-gradient(135deg, rgba(22, 163, 74, 0.08), rgba(8, 15, 12, 0.65))',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25), 0 6px 12px -2px rgba(34, 197, 94, 0.15)',
      }}
    >
      <span className="sam-type-caption text-success font-medium">
        Summary:
      </span>{' '}
      <span className="sam-type-caption text-fg-primary break-words line-clamp-2">
        {summary}
      </span>
    </div>
  );
}

export function GlassPrototype() {
  const [items] = useState<ConversationItem[]>(makeMockConversation);

  return (
    <div
      className="h-dvh relative"
      style={{ background: 'var(--sam-color-canvas, #0b1110)' }}
    >
      {/*
        Single scroll container — header and summary are sticky inside it
        so chat messages scroll BEHIND them, giving backdrop-filter blur
        something to blur.
      */}
      <div className="absolute inset-0 overflow-y-auto">
        {/* Session header — sticky at top, z-20 */}
        <div className="sticky top-0 z-20">
          <SessionHeader
            projectId="proj-mock"
            session={MOCK_SESSION}
            sessionState="active"
            loading={false}
            idleCountdownMs={null}
            taskEmbed={MOCK_SESSION.task ?? null}
            workspace={MOCK_WORKSPACE}
            node={MOCK_NODE}
            detectedPorts={MOCK_PORTS}
          />
        </div>

        {/* Summary — sticky, floats below header with inset + gap */}
        <div className="sticky top-[52px] z-10 mx-3 mt-2">
          <GlassSummary summary={MOCK_SUMMARY} />
        </div>

        {/* Messages */}
        <div className="px-4 py-4 space-y-1">
          {items.map((item) => (
            <AcpConversationItemView key={item.id} item={item} />
          ))}
        </div>

        {/* Bottom padding for scroll */}
        <div className="h-32" />
      </div>
    </div>
  );
}
