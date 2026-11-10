// How the panel looks in this browser. Settings live in localStorage, added pictures in
// IndexedDB; nothing here reaches the Core. The default background is the owner's picture at
// public/background.local.jpg, kept out of git because it is game art. Where that file is
// missing, the gradient underneath shows instead.

import { useSyncExternalStore } from "react";
import { deleteBackgroundImage, loadBackgroundImage, saveBackgroundImage } from "@/lib/image-store";
import { readJson, writeJson } from "@/lib/storage";

const STORAGE_KEY = "miyoria.panel.look.v2";

/** Paired on purpose: most free pairs of accents leave the charts unreadable. */
export const THEMES = {
  sakura: { label: "櫻花", primary: "#f29dc4", secondary: "#7355e8", chart: ["#d9609a", "#8a68ee", "#b4427f", "#6b4ee0"] },
  dusk: { label: "夕陽", primary: "#f5a68c", secondary: "#4a6ad8", chart: ["#d9744f", "#5a7fe0", "#b4552f", "#3f62cc"] },
  mint: { label: "薄荷", primary: "#8fe0c8", secondary: "#4a6ad8", chart: ["#2f9e84", "#5a7fe0", "#227f6a", "#3f62cc"] },
  tide: { label: "海潮", primary: "#f5a68c", secondary: "#0c7f7a", chart: ["#d9744f", "#169e97", "#b4552f", "#0f7f79"] },
} as const;

export type ThemeId = keyof typeof THEMES;
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

const DUSK =
  "radial-gradient(90% 70% at 78% 8%, #8a6a86 0%, transparent 62%), radial-gradient(80% 80% at 12% 96%, #5c5f8e 0%, transparent 60%), linear-gradient(160deg, #3b4a66 0%, #2e3350 45%, #4a3350 100%)";

export const BACKGROUNDS = [
  {
    id: "picture",
    label: "預設圖",
    css: `url("/background.local.jpg") 24% 62% / auto 150% no-repeat, ${DUSK}`,
  },
  { id: "solid-ink", label: "墨黑", css: "#0b0d12" },
  { id: "solid-night", label: "夜藍", css: "#1b2233" },
  {
    id: "gradient-dusk",
    label: "暮色",
    css: DUSK,
  },
  {
    id: "gradient-tide",
    label: "海霧",
    css: "radial-gradient(90% 70% at 20% 6%, #6f8ba0 0%, transparent 60%), radial-gradient(80% 70% at 88% 92%, #3f7a80 0%, transparent 62%), linear-gradient(170deg, #2c3f52 0%, #22384a 50%, #1d3a42 100%)",
  },
  {
    id: "gradient-wisteria",
    label: "藤紫",
    css: "radial-gradient(85% 70% at 70% 0%, #7f6bb0 0%, transparent 62%), radial-gradient(75% 70% at 6% 88%, #8d5a86 0%, transparent 60%), linear-gradient(165deg, #352f58 0%, #2b2747 52%, #3a2848 100%)",
  },
] as const;

export type BuiltInBackground = (typeof BACKGROUNDS)[number]["id"];
export type BackgroundId = BuiltInBackground | "user";

export type Density = "normal" | "compact";

export interface Look {
  /** 30..100 */
  brightness: number;
  /** 0..24 px */
  backgroundBlur: number;
  /** 0..24 px */
  elementBlur: number;
  /** 0..100: how dark the glass is. */
  elementMask: number;
  /** Off: every surface is an opaque dark colour. */
  glass: boolean;
  theme: ThemeId;
  density: Density;
  background: BackgroundId;
}

export const DEFAULT_LOOK: Look = {
  brightness: 66,
  backgroundBlur: 0,
  elementBlur: 7,
  elementMask: 35,
  glass: true,
  theme: "sakura",
  density: "normal",
  background: "picture",
};

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** Whatever was stored (older, edited, or broken) becomes a valid look. */
export function normalizeLook(raw: unknown): Look {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof Look, unknown>>;
  const d = DEFAULT_LOOK;
  const known = r.background === "user" || BACKGROUNDS.some((b) => b.id === r.background);
  return {
    brightness: clamp(r.brightness, 30, 100, d.brightness),
    backgroundBlur: clamp(r.backgroundBlur, 0, 24, d.backgroundBlur),
    elementBlur: clamp(r.elementBlur, 0, 24, d.elementBlur),
    elementMask: clamp(r.elementMask, 0, 100, d.elementMask),
    glass: typeof r.glass === "boolean" ? r.glass : d.glass,
    theme: THEME_IDS.includes(r.theme as ThemeId) ? (r.theme as ThemeId) : d.theme,
    density: r.density === "compact" ? "compact" : "normal",
    background: known ? (r.background as BackgroundId) : d.background,
  };
}

/** The layer variables for a mask value; the approved defaults fall out at 35. */
export function glassVariables(mask: number) {
  const t = 1 - mask / 100;
  return {
    "--sheet-a": (0.3 - 0.3 * t).toFixed(3),
    "--sheet-b": (0.42 + 0.4 * t).toFixed(3),
    "--dock-a": (0.7 - 0.6 * t).toFixed(3),
    "--well-a": (0.55 - 0.4 * t).toFixed(3),
  };
}

function apply(look: Look) {
  const root = document.documentElement;
  const theme = THEMES[look.theme];
  const vars: Record<string, string> = {
    ...glassVariables(look.elementMask),
    "--bg-brightness": (look.brightness / 100).toFixed(2),
    "--bg-blur": `${look.backgroundBlur}px`,
    "--blur": `${look.elementBlur}px`,
    "--primary": theme.primary,
    "--secondary": theme.secondary,
    "--chart-1": theme.chart[0],
    "--chart-2": theme.chart[1],
    "--chart-4": theme.chart[2],
    "--chart-5": theme.chart[3],
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.density = look.density;
  root.dataset.glass = look.glass ? "on" : "off";
}

let look: Look = normalizeLook(readJson<unknown>(STORAGE_KEY, null));
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Called once before the first render, so the page never flashes the defaults. */
export function initAppearance() {
  apply(look);
  void restoreImage();
}

export function setLook(patch: Partial<Look>) {
  look = normalizeLook({ ...look, ...patch });
  apply(look);
  writeJson(STORAGE_KEY, look);
  emit();
}

/** Back to the defaults. The owner's picture stays in the gallery. */
export function resetLook() {
  setLook(DEFAULT_LOOK);
}

export function useLook(): Look {
  return useSyncExternalStore(subscribe, () => look, () => look);
}

// ---- the owner's picture -----------------------------------------------------------------------

let imageUrl: string | null = null;

function showImage(image: Blob | null) {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = image ? URL.createObjectURL(image) : null;
  emit();
}

async function restoreImage() {
  try {
    const saved = await loadBackgroundImage();
    if (saved) showImage(saved);
  } catch {
    /* no IndexedDB here: a picture lasts for the session only */
  }
}

export function useUserImage(): string | null {
  return useSyncExternalStore(subscribe, () => imageUrl, () => imageUrl);
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

async function decodes(file: Blob): Promise<boolean> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth > 0;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type AddImageResult = "saved" | "session-only" | "too-big" | "not-an-image";

/** Shows the picture at once; `session-only` means this browser would not keep it. */
export async function addUserImage(file: File): Promise<AddImageResult> {
  if (file.size > MAX_IMAGE_BYTES) return "too-big";
  if (!(await decodes(file))) return "not-an-image";
  showImage(file);
  setLook({ background: "user" });
  try {
    await saveBackgroundImage(file);
    return "saved";
  } catch {
    return "session-only";
  }
}

export async function removeUserImage() {
  showImage(null);
  if (look.background === "user") setLook({ background: DEFAULT_LOOK.background });
  try {
    await deleteBackgroundImage();
  } catch {
    /* nothing was stored */
  }
}
