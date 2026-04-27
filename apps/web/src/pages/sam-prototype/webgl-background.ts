import { useEffect } from 'react';

const VERTEX_SHADER = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform float u_time;        // accumulated time (JS controls speed)
  uniform vec2 u_resolution;
  uniform float u_amplitude;   // 0.0 = silent, 1.0 = loud

  /* ── Simplex noise ── */
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

  /* ── Fractal Brownian Motion (3 octaves) ── */
  float fbm(vec2 p) {
    float f = 0.0;
    f += 0.5000 * snoise(p); p *= 2.02;
    f += 0.2500 * snoise(p); p *= 2.03;
    f += 0.1250 * snoise(p);
    return f / 0.875;  // normalize to roughly -1..1
  }

  /* ── 2D curl of a noise field (divergence-free velocity) ── */
  vec2 curlNoise(vec2 p) {
    float eps = 0.01;
    float dny = fbm(vec2(p.x, p.y + eps)) - fbm(vec2(p.x, p.y - eps));
    float dnx = fbm(vec2(p.x + eps, p.y)) - fbm(vec2(p.x - eps, p.y));
    return vec2(dny, -dnx) / (2.0 * eps);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    float aspect = u_resolution.x / u_resolution.y;
    vec2 p = vec2(uv.x * aspect, uv.y);

    float t = u_time;
    float amp = u_amplitude;

    // ── Step 1: Curl noise advection ──
    // Compute a divergence-free velocity field and use it to displace
    // the coordinates. This gives fluid-like swirling motion.
    vec2 curl = curlNoise(p * 1.2 + vec2(t * 0.4, t * 0.3));
    // Curl displacement strength: base flow + amplitude boost
    float curlStrength = 0.06 + amp * 0.04;
    vec2 advected = p + curl * curlStrength;

    // ── Step 2: Domain warping (Inigo Quilez technique) ──
    // Feed noise into itself for organic, ink-in-water distortion.
    // Warp intensity increases with amplitude for more turbulence.
    float warpAmt = 3.0 + amp * 1.5;

    // First warp layer: two independent fbm channels offset by magic constants
    vec2 q = vec2(
      fbm(advected * 1.4 + vec2(0.0, 0.0) + vec2(t * 0.2, t * 0.15)),
      fbm(advected * 1.4 + vec2(5.2, 1.3) + vec2(t * 0.15, -t * 0.1))
    );

    // Second warp layer: warps the already-warped coordinates
    vec2 r = vec2(
      fbm(advected * 1.4 + warpAmt * q + vec2(1.7, 9.2) + vec2(t * 0.12, t * 0.1)),
      fbm(advected * 1.4 + warpAmt * q + vec2(8.3, 2.8) + vec2(-t * 0.08, t * 0.14))
    );

    // Final evaluation through the double-warped field
    float f = fbm(advected * 1.4 + warpAmt * r);

    // Normalize to 0..1 range (fbm returns roughly -1..1)
    float combined = f * 0.5 + 0.5;

    // Use the warp displacement as a secondary color channel
    // q length indicates how much distortion is happening at each point
    float warpMagnitude = length(q);

    // ── Coloring ──
    // Three-tone palette — base dark, mid teal, bright accent
    vec3 color1 = vec3(0.0, 0.08 + amp * 0.06, 0.05 + amp * 0.04);
    vec3 color2 = vec3(0.0, 0.20 + amp * 0.20, 0.13 + amp * 0.14);
    vec3 color3 = vec3(0.05 + amp * 0.12, 0.35 + amp * 0.40, 0.22 + amp * 0.30);

    // Base color from the warped noise field
    vec3 color = mix(color1, color2, combined);

    // Bright filaments where the noise field peaks
    float brightThreshold = 0.58 - amp * 0.18;
    float bright = smoothstep(brightThreshold, 0.82, combined);
    float brightIntensity = 0.7 + amp * 1.8;
    color = mix(color, color3, bright * brightIntensity);

    // Secondary color variation from warp magnitude —
    // areas of high distortion get a slightly different tint (more blue-green)
    vec3 warpTint = vec3(0.01, 0.12 + amp * 0.15, 0.10 + amp * 0.10);
    color += warpTint * smoothstep(0.3, 0.8, warpMagnitude) * (0.3 + amp * 0.4);

    // Broad glow lift when speaking
    float glow = smoothstep(0.15, 0.55, combined) * amp * 0.35;
    color += vec3(0.03, 0.16, 0.09) * glow;

    // Vignette — opens up when loud
    float vignetteStrength = 0.75 - amp * 0.30;
    float vignette = 1.0 - length(uv - 0.5) * vignetteStrength;
    color *= vignette;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Hook: WebGL background that responds to an amplitude ref (0-1). */
export function useWebGLBackground(
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
    let prevTimestamp = performance.now();
    // Accumulated time — JS controls speed so the shader pattern never jumps
    let accumulatedTime = 0;
    // Smoothed amplitude for shader (avoids jitter)
    let smoothedAmp = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio, 1.5);
      canvas!.width = canvas!.clientWidth * dpr;
      canvas!.height = canvas!.clientHeight * dpr;
      gl!.viewport(0, 0, canvas!.width, canvas!.height);
    }

    function render() {
      const now = performance.now();
      const deltaSeconds = Math.min((now - prevTimestamp) / 1000, 0.1); // cap to avoid huge jumps on tab-switch
      prevTimestamp = now;

      // Smooth the amplitude — fast attack, slow decay
      const target = amplitudeRef.current ?? 0;
      if (target > smoothedAmp) {
        smoothedAmp += (target - smoothedAmp) * 0.3; // fast attack
      } else {
        smoothedAmp += (target - smoothedAmp) * 0.05; // slow decay
      }

      // Accumulate time: base speed + amplitude boost
      // Base 0.08, max ~0.32 when loud — pattern smoothly accelerates
      const speed = 0.08 + smoothedAmp * 0.24;
      accumulatedTime += deltaSeconds * speed;

      gl!.uniform1f(timeLoc, accumulatedTime);
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
