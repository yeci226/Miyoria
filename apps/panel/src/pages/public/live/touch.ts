// Where on her picture a touch landed. The player draws the stream with `object-fit: contain`, so
// when the box is not 16:9 there are bars; the touch is mapped onto the picture itself and a touch
// on a bar is no touch.

import type { LiveSpot } from "./feed";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The picture's rectangle inside an element of `width` x `height` that shows it `contain`ed. */
export function contentBox(width: number, height: number, videoWidth: number, videoHeight: number): Box | null {
  if (!(width > 0 && height > 0 && videoWidth > 0 && videoHeight > 0)) return null;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const w = videoWidth * scale;
  const h = videoHeight * scale;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/**
 * A touch at (`x`, `y`), measured from the element's top left, as a spot 0..1 on the picture.
 * `null` on a bar or while the picture's size is not known yet.
 */
export function spotAt(
  x: number,
  y: number,
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
): LiveSpot | null {
  const box = contentBox(width, height, videoWidth, videoHeight);
  if (box === null) return null;
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
  return { x: fx, y: fy };
}
