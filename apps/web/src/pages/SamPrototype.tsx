import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  Clock,
  GitBranch,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Mic,
  Send,
  Square,
  Wrench,
} from 'lucide-react';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';

import { API_URL } from '../lib/api/client';

/* ===================================================================
   WebGL Shader Background — amplitude-reactive swirls
   =================================================================== */

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
  uniform float u_amplitude;   // 0.0 = silent, 1.0 = loud

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

    // Amplitude drives speed: silent=0.08, loud=0.35
    float speed = 0.08 + u_amplitude * 0.27;
    float t = u_time * speed;

    // Layer 1: large slow swirls — speed multipliers scale with amplitude
    float speedMult = 1.0 + u_amplitude * 2.5;
    float n1 = snoise(p * 1.5 + vec2(t * 0.3 * speedMult, t * 0.2 * speedMult)) * 0.5 + 0.5;
    // Layer 2: medium detail
    float n2 = snoise(p * 3.0 + vec2(-t * 0.5 * speedMult, t * 0.4 * speedMult)) * 0.5 + 0.5;
    // Layer 3: fine detail
    float n3 = snoise(p * 6.0 + vec2(t * 0.7 * speedMult, -t * 0.3 * speedMult)) * 0.5 + 0.5;

    float combined = n1 * 0.6 + n2 * 0.3 + n3 * 0.1;

    // Color palette — brightens with amplitude
    float amp = u_amplitude;
    vec3 color1 = vec3(0.0, 0.06 + amp * 0.04, 0.04 + amp * 0.02);
    vec3 color2 = vec3(0.0, 0.15 + amp * 0.15, 0.10 + amp * 0.10);
    vec3 color3 = vec3(0.02 + amp * 0.08, 0.25 + amp * 0.35, 0.15 + amp * 0.25);

    vec3 color = mix(color1, color2, combined);

    // Bright spots — threshold lowers with amplitude (more bright spots when loud)
    float brightThreshold = 0.65 - amp * 0.25;
    float bright = smoothstep(brightThreshold, 0.85, combined);
    // Bright intensity increases with amplitude
    float brightIntensity = 0.5 + amp * 1.5;
    color = mix(color, color3, bright * brightIntensity);

    // Extra glow layer when amplitude is high
    float glow = smoothstep(0.3, 0.7, combined) * amp * 0.3;
    color += vec3(0.02, 0.15, 0.08) * glow;

    // Subtle vignette (less vignette when loud — opens up)
    float vignetteStrength = 0.8 - amp * 0.3;
    float vignette = 1.0 - length(uv - 0.5) * vignetteStrength;
    color *= vignette;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Hook: WebGL background that responds to an amplitude ref (0-1). */
function useWebGLBackground(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  amplitudeRef: React.RefObject<number>,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return;

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
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const timeLoc = gl.getUniformLocation(program, 'u_time');
    const resLoc = gl.getUniformLocation(program, 'u_resolution');
    const ampLoc = gl.getUniformLocation(program, 'u_amplitude');

    let animId: number;
    const startTime = performance.now();

    // Smoothed amplitude for shader (avoids jitter)
    let smoothedAmp = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio, 1.5);
      canvas!.width = canvas!.clientWidth * dpr;
      canvas!.height = canvas!.clientHeight * dpr;
      gl!.viewport(0, 0, canvas!.width, canvas!.height);
    }

    function render() {
      const elapsed = (performance.now() - startTime) / 1000;
      // Smooth the amplitude for the shader — fast attack, slow decay
      const target = amplitudeRef.current ?? 0;
      if (target > smoothedAmp) {
        smoothedAmp += (target - smoothedAmp) * 0.3; // fast attack
      } else {
        smoothedAmp += (target - smoothedAmp) * 0.05; // slow decay
      }

      gl!.uniform1f(timeLoc, elapsed);
      gl!.uniform2f(resLoc, canvas!.width, canvas!.height);
      gl!.uniform1f(ampLoc, smoothedAmp);
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
  }, [canvasRef, amplitudeRef]);
}

/* ===================================================================
   Voice Recording Hook
   =================================================================== */

type VoiceState = 'idle' | 'recording' | 'processing' | 'error';

function useVoiceInput(opts: {
  transcribeUrl: string;
  amplitudeRef: React.MutableRefObject<number>;
  onTranscription: (text: string) => void;
}) {
  const { transcribeUrl, amplitudeRef, onTranscription } = opts;
  const [state, setState] = useState<VoiceState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) void audioCtxRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const startAmplitudeMonitor = useCallback(
    (stream: MediaStream) => {
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!;
          const avg = sum / dataArray.length;
          amplitudeRef.current = Math.min(avg / 128, 1);
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // AudioContext not supported
      }
    },
    [amplitudeRef],
  );

  const stopAmplitudeMonitor = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    amplitudeRef.current = 0;
  }, [amplitudeRef]);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    stopAmplitudeMonitor();
  }, [stopAmplitudeMonitor]);

  const start = useCallback(async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setErrorMsg('Microphone not supported');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      startAmplitudeMonitor(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : undefined;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          setState('idle');
          return;
        }

        setState('processing');
        try {
          const form = new FormData();
          form.append('audio', blob, 'recording.webm');

          const resp = await fetch(transcribeUrl, {
            method: 'POST',
            credentials: 'include',
            body: form,
          });

          if (!resp.ok) throw new Error(`Transcription failed (${resp.status})`);
          const data = (await resp.json()) as { text: string };
          if (data.text) onTranscription(data.text);
          setState('idle');
        } catch (err) {
          setState('error');
          setErrorMsg(err instanceof Error ? err.message : 'Transcription failed');
          setTimeout(() => setState('idle'), 3000);
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopAmplitudeMonitor();
        setState('error');
        setErrorMsg('Recording failed');
        setTimeout(() => setState('idle'), 3000);
      };

      recorder.start();
      setState('recording');
    } catch (err) {
      stopAmplitudeMonitor();
      setState('error');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setErrorMsg('Microphone permission denied');
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setErrorMsg('No microphone found');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Mic access failed');
      }
      setTimeout(() => setState('idle'), 3000);
    }
  }, [transcribeUrl, onTranscription, startAmplitudeMonitor, stopAmplitudeMonitor]);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') void start();
  }, [state, start, stop]);

  return { state, errorMsg, toggle };
}

/* ===================================================================
   Mock Data
   =================================================================== */

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

/** Chat message for the SAM UI. */
interface ChatMessage {
  id: string;
  role: 'user' | 'sam';
  content: string;
  timestamp: string;
  toolCalls?: Array<{ name: string; result?: unknown }>;
  isStreaming?: boolean;
}

/* ===================================================================
   Glass + Glow Styles (inline)
   =================================================================== */

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

/* -- Project Node (Overview) -- */
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

/* -- Tool Call Chip -- */
const ToolCallChip: FC<{ name: string; result?: unknown }> = ({ name }) => (
  <div
    className="inline-flex items-center gap-1.5 px-2 py-1 mt-1 mr-1 rounded-md text-xs"
    style={glass.card}
  >
    <Wrench className="w-3 h-3" style={{ color: '#3cb480' }} />
    <span className="text-white/60 font-mono">{name}</span>
  </div>
);

/* -- Message Bubble -- */
const MessageBubble: FC<{ msg: ChatMessage }> = ({ msg }) => {
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
          className="px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap"
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
          <span className={isSam ? 'text-white/80' : ''}>{msg.content}</span>
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

/* -- Overview Stats -- */
const StatsBar: FC = () => {
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

/* -- Project Detail Drawer -- */
const ProjectDetail: FC<{
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

/* ===================================================================
   Main Page
   =================================================================== */

export function SamPrototype() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const amplitudeRef = useRef(0);
  const [view, setView] = useState<'chat' | 'overview'>('chat');
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedProject, setSelectedProject] = useState<MockProject | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useWebGLBackground(canvasRef, amplitudeRef);

  // Voice input hook
  const voice = useVoiceInput({
    transcribeUrl: `${API_URL}/api/transcribe`,
    amplitudeRef,
    onTranscription: useCallback(
      (text: string) => {
        setInputValue((prev) => (prev ? `${prev} ${text}` : text));
      },
      [],
    ),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /** Send a message to SAM and stream the response via SSE. */
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isSending) return;

    setInputValue('');
    setIsSending(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages((prev) => [...prev, userMsg]);

    const samMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      {
        id: samMsgId,
        role: 'sam',
        content: '',
        timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        toolCalls: [],
        isStreaming: true,
      },
    ]);

    try {
      abortRef.current = new AbortController();
      const response = await fetch(`${API_URL}/api/sam/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: text }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error((errData as { error?: string }).error || `HTTP ${response.status}`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType = event.type as string;

          if (eventType === 'conversation_started') {
            setConversationId(event.conversationId as string);
          } else if (eventType === 'text_delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === samMsgId
                  ? { ...m, content: m.content + (event.content as string) }
                  : m,
              ),
            );
          } else if (eventType === 'tool_start') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === samMsgId
                  ? {
                      ...m,
                      toolCalls: [...(m.toolCalls || []), { name: event.tool as string }],
                    }
                  : m,
              ),
            );
          } else if (eventType === 'tool_result') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== samMsgId) return m;
                const calls = [...(m.toolCalls || [])];
                const idx = calls.findIndex((tc) => tc.name === event.tool && !tc.result);
                if (idx >= 0) calls[idx] = { name: calls[idx]!.name, result: event.result };
                return { ...m, toolCalls: calls };
              }),
            );
          } else if (eventType === 'error') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === samMsgId
                  ? {
                      ...m,
                      content:
                        m.content + `\n\n**Error:** ${event.message as string}`,
                      isStreaming: false,
                    }
                  : m,
              ),
            );
          } else if (eventType === 'done') {
            setMessages((prev) =>
              prev.map((m) => (m.id === samMsgId ? { ...m, isStreaming: false } : m)),
            );
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === samMsgId ? { ...m, isStreaming: false } : m)),
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === samMsgId
            ? {
                ...m,
                content:
                  m.content || `Failed to get response: ${(err as Error).message}`,
                isStreaming: false,
              }
            : m,
        ),
      );
    } finally {
      setIsSending(false);
      abortRef.current = null;
    }
  }, [inputValue, isSending, conversationId]);

  const handleAskAboutProject = useCallback((name: string) => {
    setSelectedProject(null);
    setView('chat');
    setInputValue(`Tell me more about ${name}`);
  }, []);

  // Mic button style based on voice state
  const micButtonStyle: React.CSSProperties = (() => {
    if (voice.state === 'recording') {
      return {
        background: 'rgba(60, 180, 120, 0.35)',
        border: '1px solid rgba(60, 180, 120, 0.5)',
        boxShadow: '0 0 20px rgba(60, 180, 120, 0.4), 0 0 40px rgba(60, 180, 120, 0.15)',
      };
    }
    if (voice.state === 'processing') {
      return {
        background: 'rgba(60, 180, 120, 0.2)',
        border: '1px solid rgba(60, 180, 120, 0.3)',
      };
    }
    if (voice.state === 'error') {
      return {
        background: 'rgba(239, 68, 68, 0.2)',
        border: '1px solid rgba(239, 68, 68, 0.3)',
      };
    }
    return {
      background: 'rgba(255, 255, 255, 0.05)',
      border: '1px solid rgba(60, 180, 120, 0.15)',
    };
  })();

  return (
    <div className="h-dvh flex flex-col relative overflow-hidden">
      {/* WebGL background canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 0 }}
      />

      {/* Content layer */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Header */}
        <header className="shrink-0 px-4 py-3 flex items-center gap-3" style={glass.header}>
          <a
            href="/dashboard"
            className="p-1 -ml-1 rounded-md transition-colors"
            style={{ color: 'rgba(255,255,255,0.4)' }}
          >
            <ArrowLeft className="w-5 h-5" />
          </a>
          <div className="flex items-center gap-2 flex-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(60, 180, 120, 0.15)',
                boxShadow: '0 0 12px rgba(60, 180, 120, 0.2)',
              }}
            >
              <Bot className="w-4 h-4" style={{ color: '#3cb480' }} />
            </div>
            <h1 className="text-base font-semibold text-white/90">SAM</h1>
          </div>
        </header>

        {/* Content */}
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
              {/* Voice error message */}
              {voice.errorMsg && (
                <div className="text-xs text-red-400/80 text-center mb-2">{voice.errorMsg}</div>
              )}
              {/* Recording indicator */}
              {voice.state === 'recording' && (
                <div className="flex items-center justify-center gap-2 mb-2">
                  <div
                    className="w-2 h-2 rounded-full animate-pulse"
                    style={{ backgroundColor: '#3cb480', boxShadow: '0 0 8px rgba(60, 180, 120, 0.6)' }}
                  />
                  <span className="text-xs text-white/50">Listening... tap mic to stop</span>
                </div>
              )}
              {voice.state === 'processing' && (
                <div className="flex items-center justify-center gap-2 mb-2">
                  <Loader2 className="w-3 h-3 animate-spin" style={{ color: '#3cb480' }} />
                  <span className="text-xs text-white/50">Transcribing...</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder={
                    voice.state === 'recording'
                      ? 'Speak now...'
                      : 'Ask SAM anything...'
                  }
                  className="flex-1 px-4 py-3 text-sm rounded-xl text-white placeholder:text-white/25 focus:outline-none focus:ring-1"
                  style={
                    {
                      ...glass.input,
                      focusRingColor: 'rgba(60, 180, 120, 0.3)',
                    } as React.CSSProperties
                  }
                />
                {/* Mic button */}
                <button
                  type="button"
                  onClick={voice.toggle}
                  disabled={voice.state === 'processing' || isSending}
                  className="p-3 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  style={micButtonStyle}
                  title={
                    voice.state === 'recording'
                      ? 'Stop recording'
                      : voice.state === 'processing'
                        ? 'Transcribing...'
                        : 'Voice input'
                  }
                  aria-label={
                    voice.state === 'recording'
                      ? 'Stop recording'
                      : 'Start voice input'
                  }
                >
                  {voice.state === 'recording' ? (
                    <Square className="w-4 h-4" fill="currentColor" />
                  ) : voice.state === 'processing' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </button>
                {/* Send button */}
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isSending}
                  className="p-3 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  style={{
                    background:
                      inputValue.trim() && !isSending
                        ? 'rgba(60, 180, 120, 0.3)'
                        : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(60, 180, 120, 0.25)',
                    ...(inputValue.trim() && !isSending ? glow.accent : {}),
                  }}
                >
                  {isSending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
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
                <ProjectNode
                  key={project.id}
                  project={project}
                  onTap={() => setSelectedProject(project)}
                />
              ))}
            </div>
            {selectedProject && (
              <ProjectDetail
                project={selectedProject}
                onClose={() => setSelectedProject(null)}
                onAsk={handleAskAboutProject}
              />
            )}
          </div>
        </div>

        {/* Floating bottom tab bar */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30">
          <div
            className="flex rounded-2xl overflow-hidden"
            style={{ ...glass.tabBar, ...glow.green }}
          >
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
            <div
              style={{
                width: '1px',
                background: 'rgba(60, 180, 120, 0.15)',
                margin: '8px 0',
              }}
            />
            <button
              type="button"
              onClick={() => setView('overview')}
              className="flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all"
              style={{
                color: view === 'overview' ? '#3cb480' : 'rgba(255,255,255,0.4)',
                background:
                  view === 'overview' ? 'rgba(60, 180, 120, 0.12)' : 'transparent',
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
