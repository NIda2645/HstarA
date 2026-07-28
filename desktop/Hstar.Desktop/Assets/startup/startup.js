import { Renderer, Program, Mesh, Triangle } from './ogl.mjs';

const MAX_COLORS = 8;
const config = Object.freeze({
  colors: ['#A6C8FF', '#5227FF', '#FF9FFC'],
  backgroundColor: '#0A29FF',
  speed: 0.5,
  streakCount: 2,
  streakWidth: 1,
  streakLength: 1,
  glow: 1,
  density: 0.6,
  twinkle: 1,
  zoom: 3,
  backgroundGlow: 0,
  opacity: 1,
  mouseInteraction: true,
  mouseStrength: 0.2,
  mouseRadius: 1,
  mouseDampening: 0.15
});

const hexToRGB = hex => {
  const value = hex.replace('#', '').padEnd(6, '0');
  return [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
};

const prepColors = input => {
  const base = input.slice(0, MAX_COLORS);
  const colors = [];
  for (let i = 0; i < MAX_COLORS; i += 1) {
    colors.push(hexToRGB(base[Math.min(i, base.length - 1)]));
  }
  const average = [0, 0, 0];
  for (let i = 0; i < base.length; i += 1) {
    average[0] += colors[i][0];
    average[1] += colors[i][1];
    average[2] += colors[i][2];
  }
  average[0] /= base.length;
  average[1] /= base.length;
  average[2] /= base.length;
  return { colors, count: base.length, average };
};

const vertex = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = `
precision highp float;

uniform vec3  iResolution;
uniform vec2  iMouse;
uniform float iTime;

uniform vec3  uColor0;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
uniform vec3  uColor4;
uniform vec3  uColor5;
uniform vec3  uColor6;
uniform vec3  uColor7;
uniform int   uColorCount;

uniform vec3  uBgColor;
uniform vec3  uMouseColor;
uniform float uSpeed;
uniform int   uStreakCount;
uniform float uStreakWidth;
uniform float uStreakLength;
uniform float uGlow;
uniform float uDensity;
uniform float uTwinkle;
uniform float uZoom;
uniform float uBgGlow;
uniform float uOpacity;
uniform float uMouseEnabled;
uniform float uMouseStrength;
uniform float uMouseRadius;

varying vec2 vUv;

vec3 palette(float h) {
  int count = uColorCount;
  if (count < 1) count = 1;
  int idx = int(floor(clamp(h, 0.0, 0.999999) * float(count)));
  if (idx <= 0) return uColor0;
  if (idx == 1) return uColor1;
  if (idx == 2) return uColor2;
  if (idx == 3) return uColor3;
  if (idx == 4) return uColor4;
  if (idx == 5) return uColor5;
  if (idx == 6) return uColor6;
  return uColor7;
}

vec3 tanhv(vec3 x) {
  vec3 e = exp(-2.0 * x);
  return (1.0 - e) / (1.0 + e);
}

vec2 sceneC(vec2 frag, vec2 r) {
  vec2 P = (frag + frag - r) / r.x;
  float z = 0.0;
  float d = 1e3;
  vec4 O = vec4(0.0);
  for (int k = 0; k < 39; k++) {
    if (d <= 1e-4) break;
    O = z * normalize(vec4(P, uZoom, 0.0)) - vec4(0.0, 4.0, 1.0, 0.0) / 4.5;
    d = 1.0 - sqrt(length(O * O));
    z += d;
  }
  return vec2(O.x, atan(O.z, O.y));
}

void mainImage(out vec4 o, vec2 C) {
  vec2 r = iResolution.xy;
  vec2 uv0 = (C + C - r) / r.x;
  float T = 0.1 * iTime * uSpeed + 9.0;
  float angRings = max(1.0, floor(6.28318530718 * max(uDensity, 0.05) + 0.5));
  vec2 Y = vec2(5e-3, 6.28318530718 / angRings);

  vec2 c0 = sceneC(C, r);
  vec2 cdx = sceneC(C + vec2(1.0, 0.0), r);
  vec2 cdy = sceneC(C + vec2(0.0, 1.0), r);
  vec2 dCx = cdx - c0;
  vec2 dCy = cdy - c0;
  dCx.y -= 6.28318530718 * floor(dCx.y / 6.28318530718 + 0.5);
  dCy.y -= 6.28318530718 * floor(dCy.y / 6.28318530718 + 0.5);
  vec2 fw = abs(dCx) + abs(dCy);
  C = c0;

  vec2 P = vec2(2.0, 1.0) * uv0 - (r / r.x) * vec2(0.0, 1.0);
  vec4 O = vec4(uBgColor * 90.0 * uBgGlow / (1e3 * dot(P, P) + 6.0), 0.0);

  float mGlow = 0.0;
  if (uMouseEnabled > 0.5) {
    vec2 mN = (iMouse + iMouse - r) / r.x;
    float md = length(uv0 - mN);
    mGlow = exp(-md * md / max(uMouseRadius * uMouseRadius, 1e-4)) * uMouseStrength;
    O.rgb += uMouseColor * mGlow * 0.25;
  }

  float zr = 5e-4 * uStreakWidth;
  vec2 rr = vec2(max(length(fw), 1e-5));
  float tail = 19.0 / max(uStreakLength, 0.05);

  for (int m = 0; m < 16; m++) {
    if (m >= uStreakCount) break;
    float jf = float(m) + 1.0;
    float ic = fract(sin(dot(vec2(jf, floor(C.x / Y.x + 0.5)), vec2(7.0, 11.0)) * 73.0));
    vec2 Pp = C - (T + T * ic) * vec2(0.0, 1.0);
    Pp -= floor(Pp / Y + 0.5) * Y;
    float h = fract(8663.0 * ic);
    vec3 col = palette(h);
    float weight = mix(1.5, 1.0 + sin(T + 7.0 * h + 4.0), uTwinkle);
    weight *= 1.0 + mGlow * 2.0;
    vec2 inner = vec2(length(max(Pp, vec2(-1.0, 0.0))), length(Pp) - zr) - zr;
    vec2 sm = vec2(1.0) - smoothstep(-rr, rr, inner);
    O.rgb += dot(sm, vec2(exp(tail * Pp.y), 3.0)) * col * weight;
    C.x += Y.x / 8.0;
  }

  vec3 color = sqrt(tanhv(max(O.rgb * uGlow - vec3(0.04, 0.08, 0.02), 0.0)));
  o = vec4(color, uOpacity);
}

void main() {
  vec4 color;
  mainImage(color, vUv * iResolution.xy);
  gl_FragColor = color;
}
`;

function startLightfall(container) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new Renderer({
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    alpha: true,
    antialias: true
  });
  const gl = renderer.gl;
  const canvas = gl.canvas;
  container.appendChild(canvas);

  const prepared = prepColors(config.colors);
  const uniforms = {
    iResolution: { value: [gl.drawingBufferWidth, gl.drawingBufferHeight, 1] },
    iMouse: { value: [0, 0] },
    iTime: { value: 0 },
    uColor0: { value: prepared.colors[0] },
    uColor1: { value: prepared.colors[1] },
    uColor2: { value: prepared.colors[2] },
    uColor3: { value: prepared.colors[3] },
    uColor4: { value: prepared.colors[4] },
    uColor5: { value: prepared.colors[5] },
    uColor6: { value: prepared.colors[6] },
    uColor7: { value: prepared.colors[7] },
    uColorCount: { value: prepared.count },
    uBgColor: { value: hexToRGB(config.backgroundColor) },
    uMouseColor: { value: prepared.average },
    uSpeed: { value: config.speed },
    uStreakCount: { value: config.streakCount },
    uStreakWidth: { value: config.streakWidth },
    uStreakLength: { value: config.streakLength },
    uGlow: { value: config.glow },
    uDensity: { value: config.density },
    uTwinkle: { value: config.twinkle },
    uZoom: { value: config.zoom },
    uBgGlow: { value: config.backgroundGlow },
    uOpacity: { value: config.opacity },
    uMouseEnabled: { value: config.mouseInteraction && !reducedMotion ? 1 : 0 },
    uMouseStrength: { value: config.mouseStrength },
    uMouseRadius: { value: config.mouseRadius }
  };

  const program = new Program(gl, { vertex, fragment, uniforms });
  const geometry = new Triangle(gl);
  const mesh = new Mesh(gl, { geometry, program });
  const mouseTarget = [0, 0];
  let previousTime = 0;
  let animationFrame = 0;
  let disposed = false;

  const resize = () => {
    const bounds = container.getBoundingClientRect();
    renderer.setSize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    uniforms.iResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight, 1];
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  const onPointerMove = event => {
    const bounds = canvas.getBoundingClientRect();
    const scale = renderer.dpr || 1;
    mouseTarget[0] = (event.clientX - bounds.left) * scale;
    mouseTarget[1] = (bounds.height - (event.clientY - bounds.top)) * scale;
  };
  if (config.mouseInteraction && !reducedMotion) {
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  }

  const render = time => {
    if (disposed) return;
    uniforms.iTime.value = time * 0.001;
    const delta = previousTime ? (time - previousTime) / 1000 : 0;
    previousTime = time;
    const factor = 1 - Math.exp(-delta / Math.max(config.mouseDampening, 0.0001));
    uniforms.iMouse.value[0] += (mouseTarget[0] - uniforms.iMouse.value[0]) * factor;
    uniforms.iMouse.value[1] += (mouseTarget[1] - uniforms.iMouse.value[1]) * factor;
    renderer.render({ scene: mesh });
    if (!reducedMotion) animationFrame = requestAnimationFrame(render);
  };
  render(0);

  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    canvas.removeEventListener('pointermove', onPointerMove);
    program.remove?.();
    geometry.remove?.();
    mesh.remove?.();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  };
}

const container = document.getElementById('lightfall');
const failure = document.getElementById('startup-failure');
const failureMessage = document.getElementById('startup-failure-message');
const retryButton = document.getElementById('startup-retry');
const exitButton = document.getElementById('startup-exit');
let dispose = () => {};
try {
  dispose = startLightfall(container);
} catch {
  document.documentElement.classList.add('webgl-unavailable');
}

const postShellMessage = type => {
  window.chrome?.webview?.postMessage?.({ type, schemaVersion: 1 });
};
retryButton.addEventListener('click', () => postShellMessage('hstar-startup:retry'));
exitButton.addEventListener('click', () => postShellMessage('hstar-startup:exit'));

const showFailure = message => {
  failureMessage.textContent = String(message || '请重试启动，或退出后检查运行日志。');
  failure.hidden = false;
  retryButton.focus();
};
const hideFailure = () => {
  failure.hidden = true;
};

window.hstarStartup = Object.freeze({ dispose, showFailure, hideFailure });

requestAnimationFrame(() => {
  requestAnimationFrame(() => postShellMessage('hstar-startup:visual-ready'));
});
