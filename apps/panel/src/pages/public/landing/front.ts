// Which front page loads (docs/design/v5-profiles.md): the first character's hand-made one
// (`Landing.tsx`, "builtin", the default and the only one a page without the Core's tag knows), or
// the page for any other profile (`ProfileLanding.tsx`: its own content, or the plain one). Each is
// a chunk of its own, so a profile never downloads the other's page, and the builtin one loads
// exactly as it always has, without waiting on any request.

import { type ComponentType, lazy } from "react";
import { WORLD } from "@/lib/world";

export type FrontProps = { discord: boolean; notice?: string | null };

/** The page for `landing` (exported for tests). */
export function frontPageFor(landing: typeof WORLD.landing): () => Promise<{ default: ComponentType<FrontProps> }> {
  return landing === "builtin" ? () => import("./Landing") : () => import("./ProfileLanding");
}

/** This profile's front page, loaded when first drawn. */
export const FrontPage = lazy(frontPageFor(WORLD.landing));
