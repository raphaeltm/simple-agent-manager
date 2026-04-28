import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  Clock,
  GitBranch,
  Loader2,
  Wrench,
} from 'lucide-react';
import type { FC } from 'react';

import { SamMarkdown } from './sam-markdown';

/* ===================================================================
   Types
   =================================================================== */

export interface MockProject {
  id: string;
  name: string;
  repo: string;
  status: 'healthy' | 'active' | 'attention' | 'idle';
  summary: string;
  activeTasks: number;
  lastActivity: string;
  branch?: string;
  agents: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'sam';
  content: string;
  timestamp: string;
  toolCalls?: Array<{ name: string; result?: unknown }>;
  isStreaming?: boolean;
}

/* ===================================================================
   Mock Data
   =================================================================== */

export const MOCK_PROJECTS: MockProject[] = [
  {
    id: '1',
    name: 'SAM',
    repo: 'raphaeltm/simple-agent-manager',
    status: 'active',
    summary: '3 agents running: auth refactor, policy tests, blog post. Auth agent 80% done.',
    activeTasks: 3,
    lastActivity: '2 min ago',
    branch: 'sam/auth-refactor',
    agents: 3,
  },
  {
    id: '2',
    name: 'Marketing Site',
    repo: 'raphaeltm/simple-agent-manager',
    status: 'healthy',
    summary: 'All clear. Last PR merged 1h ago. No active tasks.',
    activeTasks: 0,
    lastActivity: '1h ago',
    agents: 0,
  },
  {
    id: '3',
    name: 'Mobile App',
    repo: 'raphaeltm/sam-mobile',
    status: 'attention',
    summary: 'CI failing on main. 2 agents paused waiting for dependency fix.',
    activeTasks: 2,
    lastActivity: '5 min ago',
    branch: 'sam/fix-ci-pipeline',
    agents: 2,
  },
  {
    id: '4',
    name: 'Shared Types',
    repo: 'raphaeltm/sam-shared',
    status: 'idle',
    summary: 'No recent activity. Last change 3 days ago.',
    activeTasks: 0,
    lastActivity: '3d ago',
    agents: 0,
  },
  {
    id: '5',
    name: 'VM Agent',
    repo: 'raphaeltm/simple-agent-manager',
    status: 'active',
    summary: '1 agent implementing browser sidecar improvements. 60% through checklist.',
    activeTasks: 1,
    lastActivity: '30s ago',
    branch: 'sam/neko-perf',
    agents: 1,
  },
];

/* ===================================================================
   Glass + Glow Styles (inline)
   =================================================================== */

export const glass = {
  panel: {
    background: 'rgba(10, 20, 16, 0.55)',
    backdropFilter: 'blur(20px) saturate(1.3)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.3)',
    border: '1px solid rgba(60, 180, 120, 0.12)',
  } as React.CSSProperties,
  panelHover: {
    background: 'rgba(15, 30, 22, 0.65)',
    backdropFilter: 'blur(20px) saturate(1.3)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.3)',
    border: '1px solid rgba(60, 180, 120, 0.2)',
  } as React.CSSProperties,
  header: {
    background: 'rgba(5, 12, 8, 0.7)',
    backdropFilter: 'blur(24px) saturate(1.4)',
    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
    borderBottom: '1px solid rgba(60, 180, 120, 0.1)',
  } as React.CSSProperties,
  input: {
    background: 'rgba(5, 15, 10, 0.6)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(60, 180, 120, 0.15)',
  } as React.CSSProperties,
  card: {
    background: 'rgba(8, 25, 16, 0.5)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(60, 180, 120, 0.1)',
  } as React.CSSProperties,
  samBubble: {
    background: 'rgba(12, 30, 20, 0.6)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(60, 180, 120, 0.12)',
  } as React.CSSProperties,
  userBubble: {
    background: 'rgba(30, 120, 80, 0.35)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(60, 180, 120, 0.25)',
  } as React.CSSProperties,
  tabBar: {
    background: 'rgba(5, 12, 8, 0.75)',
    backdropFilter: 'blur(24px) saturate(1.5)',
    WebkitBackdropFilter: 'blur(24px) saturate(1.5)',
    border: '1px solid rgba(60, 180, 120, 0.15)',
  } as React.CSSProperties,
};

export const glow = {
  green: {
    boxShadow: '0 0 20px rgba(40, 160, 100, 0.15), 0 0 60px rgba(40, 160, 100, 0.05)',
  } as React.CSSProperties,
  greenStrong: {
    boxShadow: '0 0 15px rgba(40, 160, 100, 0.3), 0 0 40px rgba(40, 160, 100, 0.1)',
  } as React.CSSProperties,
  amber: {
    boxShadow: '0 0 15px rgba(200, 150, 40, 0.2), 0 0 40px rgba(200, 150, 40, 0.05)',
  } as React.CSSProperties,
  accent: { boxShadow: '0 0 12px rgba(60, 180, 120, 0.25)' } as React.CSSProperties,
};

/* ===================================================================
   Components
   =================================================================== */

const STATUS_CONFIG = {
  healthy: { color: '#34d399', label: 'Healthy', glowStyle: glow.green },
  active: { color: '#3cb480', label: 'Active', glowStyle: glow.greenStrong },
  attention: { color: '#f59e0b', label: 'Needs Attention', glowStyle: glow.amber },
  idle: { color: '#6b7280', label: 'Idle', glowStyle: {} },
} as const;

export const ProjectNode: FC<{ project: MockProject; onTap: () => void }> = ({ project, onTap }) => {
  const cfg = STATUS_CONFIG[project.status];
  const isActive = project.status === 'active' || project.status === 'attention';

  return (
    <button
      type="button"
      onClick={onTap}
      className="w-full text-left p-4 rounded-xl transition-all duration-200 group"
      style={{ ...glass.panel, ...cfg.glowStyle }}
    >
      <div className="flex items-center gap-3 mb-2">
        <div className="relative">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: cfg.color, boxShadow: `0 0 8px ${cfg.color}60` }}
          />
          {isActive && (
            <div
              className="absolute inset-0 w-3 h-3 rounded-full animate-ping opacity-40"
              style={{ backgroundColor: cfg.color }}
            />
          )}
        </div>
        <span className="font-semibold text-white/90 text-sm truncate flex-1">{project.name}</span>
        {project.agents > 0 && (
          <span className="flex items-center gap-1 text-xs text-white/40">
            <Bot className="w-3 h-3" />
            {project.agents}
          </span>
        )}
        <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/40 transition-colors shrink-0" />
      </div>
      <p className="text-xs text-white/50 leading-relaxed mb-2 line-clamp-2">{project.summary}</p>
      <div className="flex items-center gap-3 text-xs text-white/30">
        {project.branch && (
          <span className="flex items-center gap-1 truncate">
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate font-mono">{project.branch}</span>
          </span>
        )}
        <span className="flex items-center gap-1 shrink-0 ml-auto">
          <Clock className="w-3 h-3" />
          {project.lastActivity}
        </span>
      </div>
    </button>
  );
};

const ToolCallChip: FC<{ name: string; result?: unknown }> = ({ name }) => (
  <div
    className="inline-flex items-center gap-1.5 px-2 py-1 mt-1 mr-1 rounded-md text-xs"
    style={glass.card}
  >
    <Wrench className="w-3 h-3" style={{ color: '#3cb480' }} />
    <span className="text-white/60 font-mono">{name}</span>
  </div>
);

export const MessageBubble: FC<{ msg: ChatMessage }> = ({ msg }) => {
  const isSam = msg.role === 'sam';
  return (
    <div className={`flex ${isSam ? 'justify-start' : 'justify-end'} mb-4`}>
      <div className="max-w-[85%]">
        {isSam && (
          <div className="flex items-center gap-1.5 mb-1.5">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(60, 180, 120, 0.2)',
                boxShadow: '0 0 8px rgba(60, 180, 120, 0.15)',
              }}
            >
              <Bot className="w-3 h-3" style={{ color: '#3cb480' }} />
            </div>
            <span className="text-xs font-medium" style={{ color: '#3cb480' }}>
              SAM
            </span>
            <span className="text-xs text-white/30">{msg.timestamp}</span>
            {msg.isStreaming && (
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: '#3cb480' }} />
            )}
          </div>
        )}
        <div
          className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${isSam ? '' : 'whitespace-pre-wrap'}`}
          style={
            isSam
              ? { ...glass.samBubble, borderTopLeftRadius: '4px' }
              : {
                  ...glass.userBubble,
                  borderTopRightRadius: '4px',
                  color: 'rgba(255,255,255,0.9)',
                }
          }
        >
          {isSam ? (
            <SamMarkdown content={msg.content} />
          ) : (
            <span>{msg.content}</span>
          )}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div className="mt-2 flex flex-wrap">
              {msg.toolCalls.map((tc, i) => (
                <ToolCallChip key={i} name={tc.name} result={tc.result} />
              ))}
            </div>
          )}
        </div>
        {!isSam && <div className="text-xs text-white/25 text-right mt-1">{msg.timestamp}</div>}
      </div>
    </div>
  );
};

export const StatsBar: FC = () => {
  const active = MOCK_PROJECTS.filter((p) => p.status === 'active').length;
  const attention = MOCK_PROJECTS.filter((p) => p.status === 'attention').length;
  const totalAgents = MOCK_PROJECTS.reduce((sum, p) => sum + p.agents, 0);
  return (
    <div
      className="flex gap-4 px-4 py-3"
      style={{ borderBottom: '1px solid rgba(60, 180, 120, 0.08)' }}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: '#3cb480', boxShadow: '0 0 6px rgba(60, 180, 120, 0.4)' }}
        />
        <span className="text-white/40">
          <span className="font-semibold text-white/80">{active}</span> active
        </span>
      </div>
      {attention > 0 && (
        <div className="flex items-center gap-1.5 text-xs">
          <AlertTriangle className="w-3 h-3" style={{ color: '#f59e0b' }} />
          <span className="text-white/40">
            <span className="font-semibold" style={{ color: '#f59e0b' }}>
              {attention}
            </span>{' '}
            attention
          </span>
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs ml-auto">
        <Bot className="w-3 h-3 text-white/30" />
        <span className="text-white/40">
          <span className="font-semibold text-white/80">{totalAgents}</span> agents
        </span>
      </div>
    </div>
  );
};

export const ProjectDetail: FC<{
  project: MockProject;
  onClose: () => void;
  onAsk: (name: string) => void;
}> = ({ project, onClose, onAsk }) => {
  const cfg = STATUS_CONFIG[project.status];
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col"
      style={{
        background: 'rgba(2, 8, 5, 0.95)',
        backdropFilter: 'blur(30px)',
        WebkitBackdropFilter: 'blur(30px)',
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: '1px solid rgba(60, 180, 120, 0.1)' }}
      >
        <button
          type="button"
          onClick={onClose}
          className="p-1 -ml-1 rounded-md transition-colors"
          style={{ color: 'rgba(255,255,255,0.5)' }}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white/90 text-sm truncate">{project.name}</div>
          <div className="text-xs text-white/30 truncate font-mono">{project.repo}</div>
        </div>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: cfg.color }}>
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: cfg.color, boxShadow: `0 0 6px ${cfg.color}60` }}
          />
          {cfg.label}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="p-3.5 rounded-xl" style={glass.panel}>
          <h3 className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-2">
            Summary
          </h3>
          <p className="text-sm text-white/70 leading-relaxed">{project.summary}</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { val: project.activeTasks, label: 'Tasks' },
            { val: project.agents, label: 'Agents' },
            { val: project.lastActivity, label: 'Last active', small: true },
          ].map((item) => (
            <div key={item.label} className="p-3 rounded-xl text-center" style={glass.panel}>
              <div
                className={`font-bold text-white/90 ${item.small ? 'text-xs mt-0.5' : 'text-lg'}`}
              >
                {item.val}
              </div>
              <div className="text-xs text-white/30 mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>
        {project.branch && (
          <div className="p-3.5 rounded-xl" style={glass.panel}>
            <h3 className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-2">
              Active Branch
            </h3>
            <div className="flex items-center gap-2 text-sm">
              <GitBranch className="w-4 h-4" style={{ color: '#3cb480' }} />
              <code className="font-mono text-xs text-white/70">{project.branch}</code>
            </div>
          </div>
        )}
        <div className="space-y-2 pt-2">
          <button
            type="button"
            className="w-full px-4 py-3 text-sm font-medium rounded-xl text-white transition-all"
            style={{
              background: 'rgba(60, 180, 120, 0.25)',
              border: '1px solid rgba(60, 180, 120, 0.35)',
              ...glow.accent,
            }}
            onClick={() => onAsk(project.name)}
          >
            Ask SAM about this project
          </button>
          <button
            type="button"
            className="w-full px-4 py-3 text-sm font-medium rounded-xl text-white/60 transition-colors"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            Open project
          </button>
        </div>
      </div>
    </div>
  );
};
