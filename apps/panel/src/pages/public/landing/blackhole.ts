// The black hole behind her name: sayed1145/glsl-black-hole's passes (see blackhole-glsl.ts for its
// licence), mounted on any canvas. The lensing map is traced once; each frame only re-lights the
// disc, blurs it into four bloom levels and composites. Its animation is an 8 s loop.

import { PARAMETERS, SHADERS } from "./blackhole-glsl";

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };
type Target = { texture: WebGLTexture; fbo: WebGLFramebuffer; size: number };

export interface BlackHole {
  /** Draws the frame for `seconds` (any number; the loop wraps it). */
  render(seconds: number): void;
  dispose(): void;
}

const VERTEX = "#version 300 es\nprecision highp float;\nin vec2 in_pos;\nvoid main(){gl_Position=vec4(in_pos,0.,1.);}";
const HEADER = "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;";

/** `null` where WebGL 2 or float render targets are missing; the page then shows no hole. */
export function mountBlackHole(canvas: HTMLCanvasElement, size: number): BlackHole | null {
  const gl = canvas.getContext("webgl2", { alpha: false, depth: false, stencil: false, antialias: false });
  if (!gl?.getExtension("EXT_color_buffer_float")) return null;
  gl.getExtension("OES_texture_float_linear");

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type) as WebGLShader;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const program = (src: string): Program => {
    const p = gl.createProgram() as WebGLProgram;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, src.replace("#version 330", HEADER)));
    gl.bindAttribLocation(p, 0, "in_pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return { program: p, uniforms: new Map() };
  };

  let programs: Record<keyof typeof SHADERS, Program>;
  try {
    programs = {
      geometry: program(SHADERS.geometry),
      emission: program(SHADERS.emission),
      blur: program(SHADERS.blur),
      composite: program(SHADERS.composite),
    };
  } catch {
    return null;
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const loc = (p: Program, name: string) => {
    if (!p.uniforms.has(name)) p.uniforms.set(name, gl.getUniformLocation(p.program, name));
    return p.uniforms.get(name) ?? null;
  };
  const f1 = (p: Program, n: string, v: number) => gl.uniform1f(loc(p, n), v);
  const f2 = (p: Program, n: string, x: number, y: number) => gl.uniform2f(loc(p, n), x, y);
  const tex = (p: Program, n: string, unit: number, t: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc(p, n), unit);
  };

  const textures: WebGLTexture[] = [];
  const fbos: WebGLFramebuffer[] = [];
  const texture = (s: number, internal: number, type: number, linear: boolean) => {
    const t = gl.createTexture() as WebGLTexture;
    textures.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, s, s, 0, gl.RGBA, type, null);
    return t;
  };
  const framebuffer = (ts: WebGLTexture[]) => {
    const fb = gl.createFramebuffer() as WebGLFramebuffer;
    fbos.push(fb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.drawBuffers(
      ts.map((t, i) => {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
        return gl.COLOR_ATTACHMENT0 + i;
      }),
    );
    return fb;
  };
  const target = (s: number): Target => {
    const t = texture(s, gl.RGBA16F, gl.HALF_FLOAT, true);
    return { texture: t, fbo: framebuffer([t]), size: s };
  };
  const use = (p: Program, fb: WebGLFramebuffer | null, s: number) => {
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL, not a React hook
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, s, s);
  };
  const common = (p: Program, time: number) => {
    f2(p, "uResolution", size, size);
    f2(p, "uCenter", PARAMETERS.center[0], PARAMETERS.center[1]);
    f1(p, "uTilt", PARAMETERS.tilt);
    f1(p, "uTime", ((time % 8) + 8) % 8);
  };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  canvas.width = size;
  canvas.height = size;
  const maps = [0, 1, 2].map(() => texture(size, gl.RGBA32F, gl.FLOAT, false));
  const geometry = framebuffer(maps);
  const hdr = target(size);
  const blooms = [2, 4, 12, 24].map((d) => {
    const s = Math.max(8, Math.floor(size / d));
    return [target(s), target(s)] as const;
  });

  // The optical map: where each pixel's ray crosses the disc, traced once.
  use(programs.geometry, geometry, size);
  common(programs.geometry, 0);
  f1(programs.geometry, "uScale", PARAMETERS.scale);
  f1(programs.geometry, "uInclination", PARAMETERS.inclination);
  f1(programs.geometry, "uInner", PARAMETERS.inner);
  draw();

  return {
    render(seconds) {
      let p = programs.emission;
      use(p, hdr.fbo, size);
      common(p, seconds);
      maps.forEach((t, i) => {
        tex(p, `uMap${i}`, i, t);
      });
      draw();
      p = programs.blur;
      let source = hdr.texture;
      for (const [a, b] of blooms) {
        use(p, a.fbo, a.size);
        f2(p, "uResolution", a.size, a.size);
        f2(p, "uDirection", 1 / a.size, 0);
        tex(p, "uSource", 0, source);
        draw();
        use(p, b.fbo, b.size);
        f2(p, "uDirection", 0, 1 / b.size);
        tex(p, "uSource", 0, a.texture);
        draw();
        source = b.texture;
      }
      p = programs.composite;
      use(p, null, size);
      common(p, seconds);
      tex(p, "uEmission", 0, hdr.texture);
      blooms.forEach((pair, i) => {
        tex(p, `uBloom${i}`, i + 1, pair[1].texture);
      });
      draw();
    },
    dispose() {
      for (const t of textures) gl.deleteTexture(t);
      for (const fb of fbos) gl.deleteFramebuffer(fb);
      for (const p of Object.values(programs)) gl.deleteProgram(p.program);
    },
  };
}
