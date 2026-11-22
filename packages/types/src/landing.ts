// The public front page belongs to the profile (docs/design/v5-profiles.md §8): its own content in
// `profiles/<id>/landing/landing.json` with its pictures beside it, the first character's
// hand-made page (`{"builtin": "miyoria"}`, what `profiles/deepseek-chan/` ships), or, without a
// file, a plain page built from `[character]`. Core reads the file at boot and provides the result;
// the API serves the content and the pictures, and tells the panel which page to draw.

import { serviceKey } from "./service-key.js";

/** Which front page the panel draws. */
export type LandingKind = "builtin" | "own" | "plain";

export interface LandingSection {
  readonly title: string;
  readonly text: string;
  /** A picture's file name in the landing folder; `null`: none. */
  readonly image: string | null;
}

/** A profile's own front page: plain text and pictures from its landing folder. */
export interface LandingContent {
  /** The line under her name; `null`: the plain page's line. */
  readonly line: string | null;
  /** The cover picture's file name; `null`: none. */
  readonly cover: string | null;
  readonly sections: readonly LandingSection[];
}

export type ProfileLanding =
  | { readonly kind: "builtin" }
  | { readonly kind: "plain" }
  /** `dir`: the landing folder the pictures are read from. */
  | { readonly kind: "own"; readonly dir: string; readonly content: LandingContent };

/** The running profile's front page; absent (a bare test registry): the first character's. */
export const ProfileLandingKey = serviceKey<ProfileLanding>("ProfileLanding");

/** What a registry without the service has: the page the first character always had. */
export const DEFAULT_LANDING: ProfileLanding = Object.freeze({ kind: "builtin" });
