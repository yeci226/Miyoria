// The page the card renderer drives: loads her Live2D model with Live2D's own Web Framework, holds
// a pose (parameters set, an expression's parameters added, physics let settle) and returns the
// frame as a PNG with a clear background. `render.ts` opens it in a headless browser.

import { CubismFramework, LogLevel, Option } from "../vendor/framework/src/live2dcubismframework";
import { CubismMatrix44 } from "../vendor/framework/src/math/cubismmatrix44";
import { CubismUserModel } from "../vendor/framework/src/model/cubismusermodel";

/** One picture: what she does and how it is framed. */
export interface PoseSpec {
  /** URL of the `.model3.json`. */
  model: string;
  /** Parameter values set outright (angles, eyes, mouth). */
  set: Record<string, number>;
  /** Parameter values added, as an `.exp3.json` with `Blend: Add` does (toggles). */
  add: Record<string, number>;
  width: number;
  height: number;
  /** 1 fits the model's whole canvas height; 2 shows half of it. */
  zoom: number;
  /** Model point at the middle of the picture, in model units (the canvas is 2 high, -1..1). */
  centerX: number;
  centerY: number;
  /** Seconds of physics before the frame is taken, so hair and cloth come to rest. */
  settle: number;
}

interface ModelJson {
  FileReferences: { Moc: string; Textures: string[]; Physics?: string };
}

class Her extends CubismUserModel {
  physics() {
    return this._physics;
  }
}

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const gl = canvas.getContext("webgl2", {
  alpha: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: true,
}) as WebGL2RenderingContext;

const option = new Option();
option.logFunction = (m: string) => console.log(m);
option.loggingLevel = LogLevel.LogLevel_Warning;
CubismFramework.startUp(option);
CubismFramework.initialize();

/** Masks per buffer are limited (36); a model with many clipped parts needs more buffers, or the rest draw unclipped. */
const MASK_BUFFERS = 8;

const loaded = new Map<string, Promise<Her>>();

async function bytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

async function texture(url: string): Promise<WebGLTexture> {
  const blob = await (await fetch(url)).blob();
  const image = await createImageBitmap(blob, { premultiplyAlpha: "premultiply" });
  const tex = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

async function load(url: string): Promise<Her> {
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const json = JSON.parse(new TextDecoder().decode(await bytes(url))) as ModelJson;
  const her = new Her();
  her.loadModel(await bytes(base + json.FileReferences.Moc));
  if (json.FileReferences.Physics) {
    const physics = await bytes(base + json.FileReferences.Physics);
    her.loadPhysics(physics, physics.byteLength);
  }
  her.createRenderer(MASK_BUFFERS);
  const renderer = her.getRenderer();
  // Before startUp: setting the size makes a new clipping manager, which startUp gives the context.
  renderer.setClippingMaskBufferSize(2048);
  renderer.startUp(gl);
  renderer.setIsPremultipliedAlpha(true);
  const textures = await Promise.all(json.FileReferences.Textures.map((t) => texture(base + t)));
  textures.forEach((t, i) => {
    renderer.bindTexture(i, t);
  });
  return her;
}

function model(url: string): Promise<Her> {
  let her = loaded.get(url);
  if (!her) {
    her = load(url);
    loaded.set(url, her);
  }
  return her;
}

function hold(her: Her, spec: PoseSpec): void {
  const m = her.getModel();
  const ids = CubismFramework.getIdManager();
  m.loadParameters();
  for (const [id, v] of Object.entries(spec.set)) m.setParameterValueById(ids.getId(id), v);
  for (const [id, v] of Object.entries(spec.add)) m.addParameterValueById(ids.getId(id), v);
}

function draw(her: Her, spec: PoseSpec): void {
  const { width: w, height: h } = spec;
  const projection = new CubismMatrix44();
  // Model units to clip space: 2 model units span the picture's height at zoom 1.
  projection.scale((spec.zoom * h) / w, spec.zoom);
  projection.translateRelative(-spec.centerX, -spec.centerY);
  projection.multiplyByMatrix(her.getModelMatrix());
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const renderer = her.getRenderer();
  renderer.setMvpMatrix(projection);
  renderer.setRenderState(null as unknown as WebGLFramebuffer, [0, 0, w, h]);
  renderer.drawModel();
}

/** Holds the pose, lets physics settle, and returns the frame as a PNG data URL. */
async function render(spec: PoseSpec): Promise<string> {
  canvas.width = spec.width;
  canvas.height = spec.height;
  const her = await model(spec.model);
  const physics = her.physics();
  const dt = 1 / 30;
  const steps = Math.max(1, Math.round(spec.settle / dt));
  for (let i = 0; i < steps; i++) {
    hold(her, spec);
    physics?.evaluate(her.getModel(), dt);
    her.getModel().update();
  }
  draw(her, spec);
  return canvas.toDataURL("image/png");
}

declare global {
  interface Window {
    studio: {
      render: (spec: PoseSpec) => Promise<string>;
      parameters: (model: string) => Promise<ParameterInfo[]>;
      ready: true;
    };
  }
}

/** One of the model's parameters, with the range a pose may use. */
export interface ParameterInfo {
  id: string;
  min: number;
  max: number;
  default: number;
}

/** Every parameter of the model, for choosing poses. */
async function parameters(url: string): Promise<ParameterInfo[]> {
  const m = (await model(url)).getModel();
  const out: ParameterInfo[] = [];
  for (let i = 0; i < m.getParameterCount(); i++) {
    out.push({
      id: m.getParameterId(i).getString().s,
      min: m.getParameterMinimumValue(i),
      max: m.getParameterMaximumValue(i),
      default: m.getParameterDefaultValue(i),
    });
  }
  return out;
}

window.studio = { render, parameters, ready: true };
