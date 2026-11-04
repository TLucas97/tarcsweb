/*
 * Adapted from the Orb of ElevenLabs UI (https://github.com/elevenlabs/ui), MIT License, Copyright (c) 2025 Eleven Labs Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
 * is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 * Changes: levels come from the call's analysers and also scale the orb, the noise texture is generated here, colours
 * follow the theme, and the loop pauses.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Color, DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, Uniform, type CircleGeometry, type Mesh, type ShaderMaterial } from 'three';
import { callLevels, meterActive } from './call.ts';

const onVisibility = (fn: () => void) => {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
};
const isHidden = () => document.hidden;

// The orb's scale with nobody talking; the loudest voice grows it to about 1.06, still inside the canvas (styles.css sizes
// the still circle to match the rest scale).
const REST = 0.9;
const MIC_GROW = 0.06;
const OUT_GROW = 0.1;
// Seconds to follow a voice going up and coming down: syllables read as pulses and the orb does not flicker between them.
const RISE = 0.05;
const FALL = 0.22;
// Seconds for the thinking motion to come in or leave when the agent starts or stops a turn.
const THINK_FADE = 0.4;

// on: the call screen shows it. still: reduced motion, one frame on demand. thinking: the call connects or its agent works.
export default function CallOrb({ on, still, thinking }: { on: boolean; still: boolean; thinking: boolean }) {
  const hidden = useSyncExternalStore(onVisibility, isHidden);
  // Levels are read only by a running loop; Lite never mounts this, so its meter never starts.
  const running = on && !hidden && !still;
  useEffect(() => {
    meterActive(running);
    return () => meterActive(false);
  }, [running]);
  return (
    <Canvas
      className="vc-gl" aria-hidden="true" frameloop={!on || hidden ? 'never' : still ? 'demand' : 'always'} dpr={[1, 2]}
      resize={{ debounce: 100 }} gl={{ alpha: true, antialias: true, premultipliedAlpha: true }}
    >
      <Scene still={still} thinking={thinking} />
    </Canvas>
  );
}

function Scene({ still, thinking }: { still: boolean; thinking: boolean }) {
  const { gl, invalidate } = useThree();
  const circle = useRef<Mesh<CircleGeometry, ShaderMaterial>>(null);
  const mode = useRef({ still, thinking });
  const target = useRef<[Color, Color]>([new Color(), new Color()]);
  const speed = useRef(0.1);
  // Smoothed voice levels and how much of the thinking motion shows, from 0 to 1.
  const voice = useRef({ mic: 0, out: 0, think: 0 });

  useEffect(() => {
    mode.current = { still, thinking };
    invalidate();
  }, [still, thinking, invalidate]);

  const noise = useMemo(() => noiseTexture(Math.floor(Math.random() * 2 ** 32)), []);
  useEffect(() => () => noise.dispose(), [noise]);

  const uniforms = useMemo(() => {
    const random = splitmix32(Math.floor(Math.random() * 2 ** 32));
    return {
      uColor1: new Uniform(new Color()), uColor2: new Uniform(new Color()),
      uOffsets: { value: new Float32Array(Array.from({ length: 7 }, () => random() * Math.PI * 2)) },
      uPerlinTexture: new Uniform(noise), uTime: new Uniform(0), uAnimation: new Uniform(0.1), uInverted: new Uniform(0),
      uInputVolume: new Uniform(0), uOutputVolume: new Uniform(0), uOpacity: new Uniform(0),
    };
  }, [noise]);

  // Colours come from the call screen's CSS, light or dark, and the orb inverts on dark like the original.
  useEffect(() => {
    const apply = (first: boolean) => {
      const css = getComputedStyle(gl.domElement);
      target.current[0].set(css.getPropertyValue('--vc-orb1').trim() || '#d9a441');
      target.current[1].set(css.getPropertyValue('--vc-orb2').trim() || '#f2ddae');
      if (first) {
        uniforms.uColor1.value.copy(target.current[0]);
        uniforms.uColor2.value.copy(target.current[1]);
      }
      uniforms.uInverted.value = document.documentElement.dataset.theme === 'dark' ? 1 : 0;
      invalidate();
    };
    apply(true);
    const mo = new MutationObserver(() => apply(false));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [gl, uniforms, invalidate]);

  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault();
      setTimeout(() => gl.forceContextRestore(), 1);
    };
    canvas.addEventListener('webglcontextlost', lost, false);
    return () => canvas.removeEventListener('webglcontextlost', lost, false);
  }, [gl]);

  useFrame((_, delta) => {
    const mesh = circle.current;
    const u = mesh?.material.uniforms;
    if (!mesh || !u) return;
    if (mode.current.still) {
      // One finished frame: full opacity, the theme colours, no motion.
      u.uOpacity.value = 1;
      u.uColor1.value.copy(target.current[0]);
      u.uColor2.value.copy(target.current[1]);
      mesh.scale.setScalar(REST);
      return;
    }
    u.uTime.value += delta * 0.5;
    if (u.uOpacity.value < 1) u.uOpacity.value = Math.min(1, u.uOpacity.value + delta * 2);
    const v = voice.current;
    const [mic, out] = callLevels();
    v.mic = follow(v.mic, mic, delta, RISE, FALL);
    v.out = follow(v.out, out, delta, RISE, FALL);
    v.think = follow(v.think, mode.current.thinking ? 1 : 0, delta, THINK_FADE, THINK_FADE);
    // The original's thinking motion fills the silence while the agent works; a voice over it takes over instead of
    // hiding under its floor.
    const t = u.uTime.value * 2;
    const quiet = v.think * (1 - Math.max(v.mic, v.out));
    const lvIn = Math.max(v.mic, quiet * clamp01(0.38 + 0.07 * Math.sin(t * 0.7) + 0.05 * Math.sin(t * 2.1) * Math.sin(t * 0.37 + 1.2)));
    const lvOut = Math.max(v.out, quiet * clamp01(0.48 + 0.12 * Math.sin(t * 1.05 + 0.6)));
    const targetSpeed = 0.1 + (1 - Math.pow(lvOut - 1, 2)) * 0.9;
    speed.current += (targetSpeed - speed.current) * (1 - Math.exp(-delta / 0.15));
    u.uAnimation.value += delta * speed.current;
    // The mic widens the ring (listening), Codex's voice swirls the colours (talking); both grow the orb, Codex more.
    u.uInputVolume.value = lvIn;
    u.uOutputVolume.value = lvOut;
    mesh.scale.setScalar(REST + MIC_GROW * v.mic + OUT_GROW * v.out);
    u.uColor1.value.lerp(target.current[0], 0.08);
    u.uColor2.value.lerp(target.current[1], 0.08);
  });

  return (
    <mesh ref={circle} scale={REST}>
      <circleGeometry args={[3.5, 64]} />
      <shaderMaterial uniforms={uniforms} fragmentShader={fragmentShader} vertexShader={vertexShader} transparent />
    </mesh>
  );
}

// Tileable value noise in place of the original's remote perlin-noise.png; the shader reads its red channel.
function noiseTexture(seed: number) {
  const N = 128;
  const random = splitmix32(seed);
  const octaves = [[4, 0.5], [8, 0.3], [16, 0.2]] as const;
  const grids = octaves.map(([cells]) => Float32Array.from({ length: cells * cells }, random));
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0;
      octaves.forEach(([cells, weight], k) => {
        const at = (i: number, j: number) => grids[k][(j % cells) * cells + (i % cells)];
        const fx = (x / N) * cells;
        const fy = (y / N) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fade(fx - x0);
        const ty = fade(fy - y0);
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (top + (bottom - top) * ty) * weight;
      });
      const i = (y * N + x) * 4;
      // Averaged octaves bunch around the middle; stretch them back toward the full range.
      data[i] = data[i + 1] = data[i + 2] = Math.round(clamp01((v - 0.5) * 1.7 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, N, N, RGBAFormat);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function splitmix32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

// Eases toward a target in seconds, not frames, so 60 and 120 Hz screens move alike.
function follow(from: number, to: number, dt: number, up: number, down: number) {
  return from + (to - from) * (1 - Math.exp(-dt / (to > from ? up : down)));
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const vertexShader = /* glsl */ `
uniform float uTime;
uniform sampler2D uPerlinTexture;
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uAnimation;
uniform float uInverted;
uniform float uOffsets[7];
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uInputVolume;
uniform float uOutputVolume;
uniform float uOpacity;
uniform sampler2D uPerlinTexture;
varying vec2 vUv;

const float PI = 3.14159265358979323846;

// Draw a single oval with soft edges and calculate its gradient color
bool drawOval(vec2 polarUv, vec2 polarCenter, float a, float b, bool reverseGradient, float softness, out vec4 color) {
    vec2 p = polarUv - polarCenter;
    float oval = (p.x * p.x) / (a * a) + (p.y * p.y) / (b * b);

    float edge = smoothstep(1.0, 1.0 - softness, oval);

    if (edge > 0.0) {
        float gradient = reverseGradient ? (1.0 - (p.x / a + 1.0) / 2.0) : ((p.x / a + 1.0) / 2.0);
        // Flatten gradient toward middle value for more uniform appearance
        gradient = mix(0.5, gradient, 0.1);
        color = vec4(vec3(gradient), 0.85 * edge);
        return true;
    }
    return false;
}

// Map grayscale value to a 4-color ramp (color1, color2, color3, color4)
vec3 colorRamp(float grayscale, vec3 color1, vec3 color2, vec3 color3, vec3 color4) {
    if (grayscale < 0.33) {
        return mix(color1, color2, grayscale * 3.0);
    } else if (grayscale < 0.66) {
        return mix(color2, color3, (grayscale - 0.33) * 3.0);
    } else {
        return mix(color3, color4, (grayscale - 0.66) * 3.0);
    }
}

vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// 2D noise for the ring
float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    vec2 u = f * f * (3.0 - 2.0 * f);
    float n = mix(
        mix(dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
            dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
        mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
            dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
        u.y
    );

    return 0.5 + 0.5 * n;
}

float sharpRing(vec3 decomposed, float time) {
    float ringStart = 1.0;
    float ringWidth = 0.3;
    float noiseScale = 5.0;

    float noise = mix(
        noise2D(vec2(decomposed.x, time) * noiseScale),
        noise2D(vec2(decomposed.y, time) * noiseScale),
        decomposed.z
    );

    noise = (noise - 0.5) * 2.5;

    return ringStart + noise * ringWidth * 1.5;
}

float smoothRing(vec3 decomposed, float time) {
    float ringStart = 0.9;
    float ringWidth = 0.2;
    float noiseScale = 6.0;

    float noise = mix(
        noise2D(vec2(decomposed.x, time) * noiseScale),
        noise2D(vec2(decomposed.y, time) * noiseScale),
        decomposed.z
    );

    noise = (noise - 0.5) * 5.0;

    return ringStart + noise * ringWidth;
}

float flow(vec3 decomposed, float time) {
    return mix(
        texture(uPerlinTexture, vec2(time, decomposed.x / 2.0)).r,
        texture(uPerlinTexture, vec2(time, decomposed.y / 2.0)).r,
        decomposed.z
    );
}

void main() {
    // Normalize vUv to be centered around (0.0, 0.0)
    vec2 uv = vUv * 2.0 - 1.0;

    // Convert uv to polar coordinates
    float radius = length(uv);
    float theta = atan(uv.y, uv.x);
    if (theta < 0.0) theta += 2.0 * PI; // Normalize theta to [0, 2*PI]

    // Decomposed angle is used for sampling noise textures without seams:
    // float noise = mix(sample(decomposed.x), sample(decomposed.y), decomposed.z);
    vec3 decomposed = vec3(
        // angle in the range [0, 1]
        theta / (2.0 * PI),
        // angle offset by 180 degrees in the range [1, 2]
        mod(theta / (2.0 * PI) + 0.5, 1.0) + 1.0,
        // mixing factor between two noises
        abs(theta / PI - 1.0)
    );

    // Add noise to the angle for a flow-like distortion (reduced for flatter look)
    float noise = flow(decomposed, radius * 0.03 - uAnimation * 0.2) - 0.5;
    theta += noise * mix(0.08, 0.25, uOutputVolume);

    // Initialize the base color to white
    vec4 color = vec4(1.0, 1.0, 1.0, 1.0);

    // Original parameters for the ovals in polar coordinates
    float originalCenters[7] = float[7](0.0, 0.5 * PI, 1.0 * PI, 1.5 * PI, 2.0 * PI, 2.5 * PI, 3.0 * PI);

    // Parameters for the animated centers in polar coordinates
    float centers[7];
    for (int i = 0; i < 7; i++) {
        centers[i] = originalCenters[i] + 0.5 * sin(uTime / 20.0 + uOffsets[i]);
    }

    float a, b;
    vec4 ovalColor;

    // Check if the pixel is inside any of the ovals
    for (int i = 0; i < 7; i++) {
        float noise = texture(uPerlinTexture, vec2(mod(centers[i] + uTime * 0.05, 1.0), 0.5)).r;
        a = 0.5 + noise * 0.3; // Increased for more coverage
        b = noise * mix(3.5, 2.5, uInputVolume); // Increased height for fuller appearance
        bool reverseGradient = (i % 2 == 1); // Reverse gradient for every second oval

        // Calculate the distance in polar coordinates
        float distTheta = min(
            abs(theta - centers[i]),
            min(
                abs(theta + 2.0 * PI - centers[i]),
                abs(theta - 2.0 * PI - centers[i])
            )
        );
        float distRadius = radius;

        float softness = 0.6; // Increased softness for flatter, less pronounced edges

        // Check if the pixel is inside the oval in polar coordinates
        if (drawOval(vec2(distTheta, distRadius), vec2(0.0, 0.0), a, b, reverseGradient, softness, ovalColor)) {
            // Blend the oval color with the existing color
            color.rgb = mix(color.rgb, ovalColor.rgb, ovalColor.a);
            color.a = max(color.a, ovalColor.a); // Max alpha
        }
    }

    // Calculate both noisy rings
    float ringRadius1 = sharpRing(decomposed, uTime * 0.1);
    float ringRadius2 = smoothRing(decomposed, uTime * 0.1);

    // Adjust rings based on input volume (reduced for flatter appearance)
    float inputRadius1 = radius + uInputVolume * 0.2;
    float inputRadius2 = radius + uInputVolume * 0.15;
    float opacity1 = mix(0.2, 0.6, uInputVolume);
    float opacity2 = mix(0.15, 0.45, uInputVolume);

    // Blend both rings
    float ringAlpha1 = (inputRadius2 >= ringRadius1) ? opacity1 : 0.0;
    float ringAlpha2 = smoothstep(ringRadius2 - 0.05, ringRadius2 + 0.05, inputRadius1) * opacity2;

    float totalRingAlpha = max(ringAlpha1, ringAlpha2);

    // Apply screen blend mode for combined rings
    vec3 ringColor = vec3(1.0); // White ring color
    color.rgb = 1.0 - (1.0 - color.rgb) * (1.0 - ringColor * totalRingAlpha);

    // Define colours to ramp against greyscale (could increase the amount of colours in the ramp)
    vec3 color1 = vec3(0.0, 0.0, 0.0); // Black
    vec3 color2 = uColor1; // Darker Color
    vec3 color3 = uColor2; // Lighter Color
    vec3 color4 = vec3(1.0, 1.0, 1.0); // White

    // Convert grayscale color to the color ramp
    float luminance = mix(color.r, 1.0 - color.r, uInverted);
    color.rgb = colorRamp(luminance, color1, color2, color3, color4); // Apply the color ramp

    // Apply fade-in opacity
    color.a *= uOpacity;

    gl_FragColor = color;
}
`;
