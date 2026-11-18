// Picture messages (docs/design/v5-play.md §9, §11.5): the templates of `@miyoria/card-face/pictures`
// drawn to PNG, the `Pictures` service other modules ask through `PicturesKey`.
//
// The drawing is the path `og.ts` takes: SVG, then resvg with the bundled fonts only (no browser,
// no system fonts), so the same data gives the same picture on any machine. The glass needs what
// resvg has no filter for (a blur and a darkening of the picture behind each surface), so sharp
// prepares the backdrop first: the background picture cropped like the panel's (`24% 62%`), and
// under each surface a blurred, darkened, more saturated copy of it, exactly where the surface is.
// The template draws its fills, hairlines and text over that.
//
// A picture is kept by a hash of its template version, kind, data and background (the file's path,
// size and time), so asking again for the same thing draws nothing. Each new picture is stored in
// the artifact store (source `render`, for the person it was made for) and expires there like any
// other artifact; the kept copies here are the most recent `KEPT`. Drawing is one at a time: a
// burst of commands must not take the CPU the voice needs. Every failure answers `null`, and the
// caller sends its text alone.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { cardFontOptions } from "@miyoria/card-face/fonts";
import {
  layoutPicture,
  PICTURES_VERSION,
  type PictureLayout,
  SCALE,
  SURFACES,
} from "@miyoria/card-face/pictures";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { ArtifactStore } from "@miyoria/store";
import type {
  MemberPictureKind,
  MemberPictureResult,
  PersonId,
  PictureDataMap,
  PictureFile,
  PictureKind,
  Pictures,
  PictureWho,
} from "@miyoria/types";
import { Resvg } from "@resvg/resvg-js";
import sharp, { type OverlayOptions } from "sharp";

const log = getLogger("api.pictures");

/** Pictures kept in memory. */
const KEPT = 64;
/** The panel's own picture, in its folder (`apps/panel/DESIGN.md` "Appearance"). */
export const PANEL_BACKGROUND = "background.local.jpg";
/** Where the panel places the picture in its box (`pictureCss`: `24% 62%`). */
const FOCUS = { x: 0.24, y: 0.62 } as const;
const BASE = "#0b0d12";

/**
 * The background file a picture is drawn over: `picture_background` when set (relative to the
 * working directory), else the public page's own picture in the panel's folder; `null` when there
 * is neither (the 暮色 gradient is drawn instead).
 */
export function backgroundPath(setting: string, panelDir: string | null): string | null {
  const own = setting.trim();
  if (own !== "") return isAbsolute(own) ? own : resolve(own);
  return panelDir === null ? null : join(panelDir, PANEL_BACKGROUND);
}

/** JSON with keys in order, so the same data always hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a picture is kept by: the template version, its kind and data, and the background. */
export function pictureKey(kind: PictureKind, data: unknown, background: string): string {
  return createHash("sha256")
    .update(PICTURES_VERSION)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(stableJson(data))
    .update("\0")
    .update(background)
    .digest("hex");
}

/**
 * The backdrop under a laid-out picture, as a JPEG data URL at its pixel size: the picture behind
 * (brightness .66, saturate 1.08) and, under each surface, the same picture blurred and darkened
 * the way that glass does it (`SURFACES`).
 */
export async function backdropOf(picture: Uint8Array, layout: PictureLayout): Promise<string> {
  const W = layout.width * SCALE;
  const H = layout.height * SCALE;
  const meta = await sharp(picture).metadata();
  const iw = meta.width ?? W;
  const ih = meta.height ?? H;
  const scale = Math.max(W / iw, H / ih);
  const rw = Math.max(W, Math.ceil(iw * scale));
  const rh = Math.max(H, Math.ceil(ih * scale));
  const base = await sharp(picture)
    .resize(rw, rh, { fit: "fill" })
    .extract({
      left: Math.round((rw - W) * FOCUS.x),
      top: Math.round((rh - H) * FOCUS.y),
      width: W,
      height: H,
    })
    .removeAlpha()
    .png()
    .toBuffer();
  const pic = SURFACES.picture;
  const layers: OverlayOptions[] = [];
  for (const kind of new Set(layout.surfaces.map((s) => s.kind))) {
    const glass = SURFACES[kind];
    const frosted = await sharp(base)
      .blur(glass.blur * SCALE)
      .modulate({
        brightness: pic.brightness * glass.brightness,
        saturation: pic.saturate * glass.saturate,
      })
      .png()
      .toBuffer();
    for (const s of layout.surfaces.filter((x) => x.kind === kind)) {
      const left = Math.round(s.x * SCALE);
      const top = Math.round(s.y * SCALE);
      const width = Math.min(Math.round(s.w * SCALE), W - left);
      const height = Math.min(Math.round(s.h * SCALE), H - top);
      if (width <= 0 || height <= 0) continue;
      layers.push({
        input: await sharp(frosted).extract({ left, top, width, height }).png().toBuffer(),
        left,
        top,
      });
    }
  }
  const jpeg = await sharp(base)
    .modulate({ brightness: pic.brightness, saturation: pic.saturate })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** The SVG of a laid-out picture as a PNG at its pixel size, with the bundled fonts only. */
export async function rasterize(svg: string, width: number): Promise<Buffer> {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: width * SCALE },
    background: BASE,
    font: cardFontOptions(),
  })
    .render()
    .asPng();
  return sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/** What the renderer stores pictures in (the artifact store's `ingest`). */
export type PictureStore = Pick<ArtifactStore, "ingest">;

export interface PictureRendererOptions {
  /** The background file, asked each time (the setting is read once, the file may come and go). */
  background: () => string | null;
  /** The artifact store, when the Core has one. */
  store?: () => PictureStore | undefined;
}

/** The background as it is now: an id that changes with the file, and its bytes. */
interface Background {
  id: string;
  bytes: Uint8Array | null;
}

/** Draws pictures, keeps the recent ones, stores new ones. */
export class PictureRenderer {
  readonly #kept = new Map<string, PictureFile>();
  readonly #options: PictureRendererOptions;
  #background: Background = { id: "dusk", bytes: null };
  #drawing: Promise<unknown> = Promise.resolve();

  constructor(options: PictureRendererOptions) {
    this.#options = options;
  }

  /** The background file now; `dusk` when there is none or it cannot be read. */
  async #currentBackground(): Promise<Background> {
    const path = this.#options.background();
    if (path === null) return { id: "dusk", bytes: null };
    try {
      const s = await stat(path);
      const id = `${path}|${s.size}|${Math.floor(s.mtimeMs)}`;
      if (this.#background.id !== id) this.#background = { id, bytes: await readFile(path) };
      return this.#background;
    } catch {
      return { id: "dusk", bytes: null };
    }
  }

  #remember(key: string, file: PictureFile): void {
    this.#kept.delete(key);
    this.#kept.set(key, file);
    while (this.#kept.size > KEPT) {
      const oldest = this.#kept.keys().next().value;
      if (oldest === undefined) break;
      this.#kept.delete(oldest);
    }
  }

  /** Draws `kind` (or answers the kept one). Throws when it cannot. */
  async draw<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
    madeFor: PersonId | null = null,
  ): Promise<PictureFile> {
    const background = await this.#currentBackground();
    const key = pictureKey(kind, data, background.id);
    const hit = this.#kept.get(key);
    if (hit !== undefined) {
      this.#remember(key, hit);
      return hit;
    }
    const run = async (): Promise<PictureFile> => {
      const again = this.#kept.get(key);
      if (again !== undefined) return again;
      const layout = layoutPicture(kind, data);
      let backdrop: string | null = null;
      if (background.bytes !== null) {
        try {
          backdrop = await backdropOf(background.bytes, layout);
        } catch (error) {
          log.warn({ error: errorMessage(error) }, "cannot use the picture background");
        }
      }
      const png = await rasterize(layout.svg(backdrop), layout.width);
      const name = `miyoria-${kind}.png`;
      let artifact: string | null = null;
      const store = this.#options.store?.();
      if (store !== undefined) {
        try {
          const stored = await store.ingest(png, {
            source: "render",
            plugin: "api",
            filename: name,
            mime: "image/png",
            made_for: madeFor,
          });
          artifact = stored.id;
        } catch (error) {
          log.warn({ error: errorMessage(error) }, "cannot keep a picture in the artifact store");
        }
      }
      const file: PictureFile = {
        name,
        data: new Uint8Array(png),
        contentType: "image/png",
        alt: layout.alt,
        artifact_id: artifact,
      };
      this.#remember(key, file);
      return file;
    };
    const next = this.#drawing.then(run, run);
    this.#drawing = next.catch(() => undefined);
    return next;
  }

  /** `draw`, or `null` when it cannot. */
  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
    madeFor: PersonId | null = null,
  ): Promise<PictureFile | null> {
    try {
      return await this.draw(kind, data, madeFor);
    } catch (error) {
      log.warn({ kind, error: errorMessage(error) }, "cannot draw a picture");
      return null;
    }
  }
}

/** What a member picture is drawn from, and who it is for. */
export interface MemberPicture<K extends MemberPictureKind = MemberPictureKind> {
  kind: K;
  data: PictureDataMap[K];
  person: PersonId | null;
}

/** Puts a member's picture together; `null` when they may not have it. */
export type MemberPictures = (
  who: PictureWho,
  kind: MemberPictureKind,
) => Promise<MemberPicture | null>;

/** The `Pictures` service: the renderer, and a member's own pictures from their page's data. */
export class PictureService implements Pictures {
  constructor(
    readonly renderer: PictureRenderer,
    readonly member: MemberPictures,
  ) {}

  render<K extends PictureKind>(kind: K, data: PictureDataMap[K]): Promise<PictureFile | null> {
    return this.renderer.render(kind, data);
  }

  async forMember(
    who: PictureWho,
    kind: MemberPictureKind,
    options: { draw?: boolean } = {},
  ): Promise<MemberPictureResult | null> {
    let picture: MemberPicture | null;
    let alt: string;
    try {
      picture = await this.member(who, kind);
      if (picture === null) return null;
      alt = layoutPicture(picture.kind, picture.data as never).alt;
    } catch (error) {
      log.warn({ kind, error: errorMessage(error) }, "cannot put a member's picture together");
      return null;
    }
    if (options.draw === false) return { alt, file: null };
    const file = await this.renderer.render(picture.kind, picture.data as never, picture.person);
    return { alt: file?.alt ?? alt, file };
  }
}
