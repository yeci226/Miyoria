import { BACKGROUNDS, DEFAULT_LOOK, useLook, useUserImage } from "./appearance";

const builtIn = (id: string) => (BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS.find((b) => b.id === DEFAULT_LOOK.background))?.css;

/** The picture behind everything: the chosen background, or the default gradient. */
export function Backdrop() {
  const { background } = useLook();
  const image = useUserImage();
  // A saved picture loads a moment after the first paint; the base colour holds until then.
  const style = background === "user" ? (image ? { backgroundImage: `url("${image}")` } : undefined) : { background: builtIn(background) };
  return <div aria-hidden className="backdrop" style={style} />;
}
