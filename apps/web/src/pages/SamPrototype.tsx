import { useState, useRef, useEffect, useCallback, type FC } from 'react';
import {
  MessageSquare,
  LayoutDashboard,
  Send,
  ArrowLeft,
  Circle,
  GitBranch,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ChevronRight,
  Zap,
  Bot,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   WebGL Shader Background
   Subtle dark green/teal swirls on black
   ═══════════════════════════════════════════════════════════════ */

const VERTEX_SHADER = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform float u_time;
  uniform vec2 u_resolution;

  // Simplex-ish noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    float aspect = u_resolution.x / u_resolution.y;
    vec2 p = vec2(uv.x * aspect, uv.y);

    float t = u_time * 0.08;

    // Layer 1: large slow swirls
    float n1 = snoise(p * 1.5 + vec2(t * 0.3, t * 0.2)) * 0.5 + 0.5;
    // Layer 2: medium detail
    float n2 = snoise(p * 3.0 + vec2(-t * 0.5, t * 0.4)) * 0.5 + 0.5;
    // Layer 3: fine detail
    float n3 = snoise(p * 6.0 + vec2(t * 0.7, -t * 0.3)) * 0.5 + 0.5;

    float combined = n1 * 0.6 + n2 * 0.3 + n3 * 0.1;

    // Dark green/teal palette
    vec3 color1 = vec3(0.0, 0.06, 0.04);   // near-black green
    vec3 color2 = vec3(0.0, 0.15, 0.10);   // dark teal
    vec3 color3 = vec3(0.02, 0.25, 0.15);  // accent green (rare)

    vec3 color = mix(color1, color2, combined);
    // Add occasional brighter spots
    float bright = smoothstep(0.65, 0.85, combined);
    color = mix(color, color3, bright * 0.5);

    // Subtle vignette
    float vignette = 1.0 - length(uv - 0.5) * 0.8;
    color *= vignette;

    gl_FragColor = vec4(color, 1.0);
  }
`;

function useWebGLBackground(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return;

    // Compile shaders
    function createShader(gl: WebGLRenderingContext, type: number, source: string) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    }

    const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    // Full-screen quad
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const timeLoc = gl.getUniformLocation(program, 'u_time');
    const resLoc = gl.getUniformLocation(program, 'u_resolution');

    let animId: number;
    const startTime = performance.now();

    function resize() {
      const dpr = Math.min(window.devicePixelRatio, 1.5); // cap for perf
      canvas!.width = canvas!.clientWidth * dpr;
      canvas!.height = canvas!.clientHeight * dpr;
      gl!.viewport(0, 0, canvas!.width, canvas!.height);
    }

    function render() {
      const elapsed = (performance.now() - startTime) / 1000;
      gl!.uniform1f(timeLoc, elapsed);
      gl!.uniform2f(resLoc, canvas!.width, canvas!.height);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
      animId = requestAnimationFrame(render);
    }

    resize();
    window.addEventListener('resize', resize);
    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, [canvasRef]);
}

/* ═══════════════════════════════════════════════════════════════
   Mock Data
   ═══════════════════════════════════════════════════════════════ */

interface MockProject {
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

const MOCK_PROJECTS: MockProject[] = [
  {
    id: '1', name: 'SAM', repo: 'raphaeltm/simple-agent-manager', status: 'active',
    summary: '3 agents running: auth refactor, policy tests, blog post. Auth agent 80% done.',
    activeTasks: 3, lastActivity: '2 min ago', branch: 'sam/auth-refactor', agents: 3,
  },
  {
    id: '2', name: 'Marketing Site', repo: 'raphaeltm/simple-agent-manager', status: 'healthy',
    summary: 'All clear. Last PR merged 1h ago. No active tasks.',
    activeTasks: 0, lastActivity: '1h ago', agents: 0,
  },
  {
    id: '3', name: 'Mobile App', repo: 'raphaeltm/sam-mobile', status: 'attention',
    summary: 'CI failing on main. 2 agents paused waiting for dependency fix.',
    activeTasks: 2, lastActivity: '5 min ago', branch: 'sam/fix-ci-pipeline', agents: 2,
  },
  {
    id: '4', name: 'Shared Types', repo: 'raphaeltm/sam-shared', status: 'idle',
    summary: 'No recent activity. Last change 3 days ago.',
    activeTasks: 0, lastActivity: '3d ago', agents: 0,
  },
  {
    id: '5', name: 'VM Agent', repo: 'raphaeltm/simple-agent-manager', status: 'active',
    summary: '1 agent implementing browser sidecar improvements. 60% through checklist.',
    activeTasks: 1, lastActivity: '30s ago', branch: 'sam/neko-perf', agents: 1,
  },
];

interface MockMessage {
  id: string;
  role: 'user' | 'sam';
  content: string;
  timestamp: string;
  card?: MockCard;
}

interface MockCard {
  type: 'mission-status' | 'project-summary' | 'action-confirm';
  data: Record<string, unknown>;
}

const MOCK_MESSAGES: MockMessage[] = [
  {
    id: '1', role: 'sam', content: "Good morning, Raphael. Here's your overnight summary:", timestamp: '9:00 AM',
    card: {
      type: 'project-summary',
      data: {
        completed: 2, inProgress: 3, needsAttention: 1,
        highlights: [
          'Auth refactor PR ready for review (SAM project)',
          'CI pipeline broken on Mobile App — dependency conflict',
          'Blog post draft completed and pushed',
        ],
      },
    },
  },
  { id: '2', role: 'user', content: "What's going on with the Mobile App CI?", timestamp: '9:02 AM' },
  {
    id: '3', role: 'sam', timestamp: '9:02 AM',
    content: "The Mobile App CI started failing at 3:47 AM after a dependency update. The root cause is a version conflict between react-native@0.76 and @react-navigation/native@7.x. Two agents were working on feature branches and are now paused.\n\nI can fix the dependency conflict and unblock the agents. Should I proceed?",
    card: {
      type: 'action-confirm',
      data: { action: 'Fix dependency conflict in Mobile App', impact: 'Unblocks 2 paused agents', estimate: '~10 min' },
    },
  },
  { id: '4', role: 'user', content: 'Yes, go ahead.', timestamp: '9:03 AM' },
  {
    id: '5', role: 'sam', timestamp: '9:03 AM',
    content: "On it. I've dispatched a task to fix the dependency conflict. I'll let you know when it's resolved and the agents resume.",
    card: {
      type: 'mission-status',
      data: {
        name: 'Fix Mobile App CI',
        status: 'running',
        tasks: [
          { name: 'Diagnose dependency conflict', status: 'completed' },
          { name: 'Update package versions', status: 'running' },
          { name: 'Verify CI passes', status: 'pending' },
          { name: 'Resume paused agents', status: 'pending' },
        ],
      },
    },
  },
  { id: '6', role: 'user', content: 'How is the auth refactor going on the main SAM project?', timestamp: '9:05 AM' },
  {
    id: '7', role: 'sam', timestamp: '9:05 AM',
    content: "The auth refactor is 80% complete. The agent has finished refactoring the middleware and updating tests. Remaining work: update the OAuth callback handler and run the full integration suite. Estimated completion in about 20 minutes.\n\nThe agent hasn't hit any blockers — it's been a clean run.",
  },
];

/* ═══════════════════════════════════════════════════════════════
   Glass + Glow Styles (inline)
   ═══════════════════════════════════════════════════════════════ */

const glass = {
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

const glow = {
  green: { boxShadow: '0 0 20px rgba(40, 160, 100, 0.15), 0 0 60px rgba(40, 160, 100, 0.05)' } as React.CSSProperties,
  greenStrong: { boxShadow: '0 0 15px rgba(40, 160, 100, 0.3), 0 0 40px rgba(40, 160, 100, 0.1)' } as React.CSSProperties,
  amber: { boxShadow: '0 0 15px rgba(200, 150, 40, 0.2), 0 0 40px rgba(200, 150, 40, 0.05)' } as React.CSSProperties,
  accent: { boxShadow: '0 0 12px rgba(60, 180, 120, 0.25)' } as React.CSSProperties,
};

/* ═══════════════════════════════════════════════════════════════
   Components
   ═══════════════════════════════════════════════════════════════ */

const STATUS_CONFIG = {
  healthy: { color: '#34d399', label: 'Healthy', glowStyle: glow.green },
  active: { color: '#3cb480', label: 'Active', glowStyle: glow.greenStrong },
  attention: { color: '#f59e0b', label: 'Needs Attention', glowStyle: glow.amber },
  idle: { color: '#6b7280', label: 'Idle', glowStyle: {} },
} as const;

/* ── Project Node (Overview) ── */
const ProjectNode: FC<{ project: MockProject; onTap: () => void }> = ({ project, onTap }) => {
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
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: cfg.color, boxShadow: `0 0 8px ${cfg.color}60` }} />
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

/* ── Card Components ── */
const SummaryCard: FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const highlights = (data.highlights as string[]) || [];
  return (
    <div className="mt-2.5 p-3 rounded-lg" style={glass.card}>
      <div className="flex gap-4 mb-3">
        {[
          { val: data.completed, label: 'Done', color: '#34d399' },
          { val: data.inProgress, label: 'Running', color: '#3cb480' },
          { val: data.needsAttention, label: 'Attention', color: '#f59e0b' },
        ].map((item) => (
          <div key={item.label} className="text-center">
            <div className="text-lg font-bold" style={{ color: item.color }}>{String(item.val)}</div>
            <div className="text-xs text-white/40">{item.label}</div>
          </div>
        ))}
      </div>
      <ul className="space-y-1.5">
        {highlights.map((h, i) => (
          <li key={i} className="text-xs text-white/50 flex items-start gap-2">
            <Circle className="w-1.5 h-1.5 mt-1.5 fill-white/30 shrink-0" />
            {h}
          </li>
        ))}
      </ul>
    </div>
  );
};

const ActionCard: FC<{ data: Record<string, unknown> }> = ({ data }) => (
  <div className="mt-2.5 p-3 rounded-lg" style={{ ...glass.card, border: '1px solid rgba(60, 180, 120, 0.25)' }}>
    <div className="flex items-center gap-2 mb-1">
      <Zap className="w-4 h-4" style={{ color: '#3cb480' }} />
      <span className="text-sm font-medium text-white/90">{String(data.action)}</span>
    </div>
    <div className="text-xs text-white/40 mb-3">{String(data.impact)} &middot; {String(data.estimate)}</div>
    <div className="flex gap-2">
      <button
        type="button"
        className="px-4 py-1.5 text-xs font-medium rounded-lg text-white transition-all"
        style={{ background: 'rgba(60, 180, 120, 0.3)', border: '1px solid rgba(60, 180, 120, 0.4)', ...glow.accent }}
      >
        Approve
      </button>
      <button
        type="button"
        className="px-4 py-1.5 text-xs font-medium rounded-lg text-white/60 transition-colors"
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
      >
        More info
      </button>
    </div>
  </div>
);

const MissionCard: FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const tasks = (data.tasks as Array<{ name: string; status: string }>) || [];
  const statusIcon = (s: string) => {
    if (s === 'completed') return <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#34d399' }} />;
    if (s === 'running') return <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: '#3cb480' }} />;
    return <Circle className="w-3.5 h-3.5 text-white/20" />;
  };
  return (
    <div className="mt-2.5 p-3 rounded-lg" style={glass.card}>
      <div className="flex items-center gap-2 mb-2.5">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#3cb480' }} />
        <span className="text-sm font-medium text-white/90">{String(data.name)}</span>
      </div>
      <div className="space-y-2">
        {tasks.map((t, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            {statusIcon(t.status)}
            <span className={t.status === 'completed' ? 'text-white/30 line-through' : 'text-white/70'}>{t.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ── Message Bubble ── */
const MessageBubble: FC<{ msg: MockMessage }> = ({ msg }) => {
  const isSam = msg.role === 'sam';
  return (
    <div className={`flex ${isSam ? 'justify-start' : 'justify-end'} mb-4`}>
      <div className="max-w-[85%]">
        {isSam && (
          <div className="flex items-center gap-1.5 mb-1.5">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(60, 180, 120, 0.2)', boxShadow: '0 0 8px rgba(60, 180, 120, 0.15)' }}
            >
              <Bot className="w-3 h-3" style={{ color: '#3cb480' }} />
            </div>
            <span className="text-xs font-medium" style={{ color: '#3cb480' }}>SAM</span>
            <span className="text-xs text-white/30">{msg.timestamp}</span>
          </div>
        )}
        <div
          className="px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed"
          style={isSam ? { ...glass.samBubble, borderTopLeftRadius: '4px' } : { ...glass.userBubble, borderTopRightRadius: '4px', color: 'rgba(255,255,255,0.9)' }}
        >
          <span className={isSam ? 'text-white/80' : ''}>{msg.content}</span>
          {msg.card?.type === 'project-summary' && <SummaryCard data={msg.card.data} />}
          {msg.card?.type === 'action-confirm' && <ActionCard data={msg.card.data} />}
          {msg.card?.type === 'mission-status' && <MissionCard data={msg.card.data} />}
        </div>
        {!isSam && <div className="text-xs text-white/25 text-right mt-1">{msg.timestamp}</div>}
      </div>
    </div>
  );
};

/* ── Overview Stats ── */
const StatsBar: FC = () => {
  const active = MOCK_PROJECTS.filter((p) => p.status === 'active').length;
  const attention = MOCK_PROJECTS.filter((p) => p.status === 'attention').length;
  const totalAgents = MOCK_PROJECTS.reduce((sum, p) => sum + p.agents, 0);
  return (
    <div className="flex gap-4 px-4 py-3" style={{ borderBottom: '1px solid rgba(60, 180, 120, 0.08)' }}>
      <div className="flex items-center gap-1.5 text-xs">
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#3cb480', boxShadow: '0 0 6px rgba(60, 180, 120, 0.4)' }} />
        <span className="text-white/40"><span className="font-semibold text-white/80">{active}</span> active</span>
      </div>
      {attention > 0 && (
        <div className="flex items-center gap-1.5 text-xs">
          <AlertTriangle className="w-3 h-3" style={{ color: '#f59e0b' }} />
          <span className="text-white/40"><span className="font-semibold" style={{ color: '#f59e0b' }}>{attention}</span> attention</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs ml-auto">
        <Bot className="w-3 h-3 text-white/30" />
        <span className="text-white/40"><span className="font-semibold text-white/80">{totalAgents}</span> agents</span>
      </div>
    </div>
  );
};

/* ── Project Detail Drawer ── */
const ProjectDetail: FC<{ project: MockProject; onClose: () => void; onAsk: (name: string) => void }> = ({ project, onClose, onAsk }) => {
  const cfg = STATUS_CONFIG[project.status];
  return (
    <div className="absolute inset-0 z-20 flex flex-col" style={{ background: 'rgba(2, 8, 5, 0.95)', backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)' }}>
      <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(60, 180, 120, 0.1)' }}>
        <button type="button" onClick={onClose} className="p-1 -ml-1 rounded-md transition-colors" style={{ color: 'rgba(255,255,255,0.5)' }}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white/90 text-sm truncate">{project.name}</div>
          <div className="text-xs text-white/30 truncate font-mono">{project.repo}</div>
        </div>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: cfg.color }}>
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cfg.color, boxShadow: `0 0 6px ${cfg.color}60` }} />
          {cfg.label}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="p-3.5 rounded-xl" style={glass.panel}>
          <h3 className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-2">Summary</h3>
          <p className="text-sm text-white/70 leading-relaxed">{project.summary}</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { val: project.activeTasks, label: 'Tasks' },
            { val: project.agents, label: 'Agents' },
            { val: project.lastActivity, label: 'Last active', small: true },
          ].map((item) => (
            <div key={item.label} className="p-3 rounded-xl text-center" style={glass.panel}>
              <div className={`font-bold text-white/90 ${item.small ? 'text-xs mt-0.5' : 'text-lg'}`}>{item.val}</div>
              <div className="text-xs text-white/30 mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>
        {project.branch && (
          <div className="p-3.5 rounded-xl" style={glass.panel}>
            <h3 className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-2">Active Branch</h3>
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
            style={{ background: 'rgba(60, 180, 120, 0.25)', border: '1px solid rgba(60, 180, 120, 0.35)', ...glow.accent }}
            onClick={() => onAsk(project.name)}
          >
            Ask SAM about this project
          </button>
          <button
            type="button"
            className="w-full px-4 py-3 text-sm font-medium rounded-xl text-white/60 transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            Open project
          </button>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════════ */

export function SamPrototype() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<'chat' | 'overview'>('chat');
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<MockMessage[]>(MOCK_MESSAGES);
  const [selectedProject, setSelectedProject] = useState<MockProject | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useWebGLBackground(canvasRef);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    if (!inputValue.trim()) return;
    const newMsg: MockMessage = {
      id: String(Date.now()),
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages((prev) => [...prev, newMsg]);
    setInputValue('');
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + 1),
          role: 'sam',
          content: "I'm on it. Let me look into that and get back to you with details. (This is a prototype — responses are simulated.)",
          timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        },
      ]);
    }, 1200);
  }, [inputValue]);

  const handleAskAboutProject = useCallback((name: string) => {
    setSelectedProject(null);
    setView('chat');
    setInputValue(`Tell me more about ${name}`);
  }, []);

  return (
    <div className="h-dvh flex flex-col relative overflow-hidden">
      {/* WebGL background canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ zIndex: 0 }} />

      {/* Content layer */}
      <div className="relative z-10 flex flex-col h-full">
        {/* ── Header ── */}
        <header className="shrink-0 px-4 py-3 flex items-center gap-3" style={glass.header}>
          <a href="/dashboard" className="p-1 -ml-1 rounded-md transition-colors" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <ArrowLeft className="w-5 h-5" />
          </a>
          <div className="flex items-center gap-2 flex-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(60, 180, 120, 0.15)', boxShadow: '0 0 12px rgba(60, 180, 120, 0.2)' }}
            >
              <Bot className="w-4 h-4" style={{ color: '#3cb480' }} />
            </div>
            <h1 className="text-base font-semibold text-white/90">SAM</h1>
          </div>
        </header>

        {/* ── Content ── */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {/* Chat */}
          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-out ${
              view === 'chat' ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="flex-1 overflow-y-auto px-4 py-4">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>
            {/* Input area */}
            <div className="shrink-0 px-4 pt-2 pb-24">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="Ask SAM anything..."
                  className="flex-1 px-4 py-3 text-sm rounded-xl text-white placeholder:text-white/25 focus:outline-none focus:ring-1"
                  style={{ ...glass.input, focusRingColor: 'rgba(60, 180, 120, 0.3)' } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  className="p-3 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  style={{
                    background: inputValue.trim() ? 'rgba(60, 180, 120, 0.3)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(60, 180, 120, 0.25)',
                    ...(inputValue.trim() ? glow.accent : {}),
                  }}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Overview */}
          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-out ${
              view === 'overview' ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <StatsBar />
            <div className="flex-1 overflow-y-auto p-4 pb-24 space-y-3">
              {MOCK_PROJECTS.map((project) => (
                <ProjectNode key={project.id} project={project} onTap={() => setSelectedProject(project)} />
              ))}
            </div>
            {selectedProject && (
              <ProjectDetail project={selectedProject} onClose={() => setSelectedProject(null)} onAsk={handleAskAboutProject} />
            )}
          </div>
        </div>

        {/* ── Floating bottom tab bar ── */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30">
          <div className="flex rounded-2xl overflow-hidden" style={{ ...glass.tabBar, ...glow.green }}>
            <button
              type="button"
              onClick={() => setView('chat')}
              className="flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all"
              style={{
                color: view === 'chat' ? '#3cb480' : 'rgba(255,255,255,0.4)',
                background: view === 'chat' ? 'rgba(60, 180, 120, 0.12)' : 'transparent',
              }}
            >
              <MessageSquare className="w-4.5 h-4.5" />
              Chat
            </button>
            <div style={{ width: '1px', background: 'rgba(60, 180, 120, 0.15)', margin: '8px 0' }} />
            <button
              type="button"
              onClick={() => setView('overview')}
              className="flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all"
              style={{
                color: view === 'overview' ? '#3cb480' : 'rgba(255,255,255,0.4)',
                background: view === 'overview' ? 'rgba(60, 180, 120, 0.12)' : 'transparent',
              }}
            >
              <LayoutDashboard className="w-4.5 h-4.5" />
              Overview
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
