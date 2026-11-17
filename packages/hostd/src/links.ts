// Where Core's node links are, as Core tells this host (`cluster.links`, docs/design/v5-hostd.md
// §6.4): the values of the `{link:...}` placeholders a node's `run.env` uses. Core sends the port,
// path and token of `voice.link` (to a host approved for `voice-room`) and `stage.link` (for
// `renderer`), and the whole address only when its config has a public one; otherwise the address
// is built here from the host name this machine dials Core by (`[cluster] url`): `ws`, or `wss`
// when the cluster URL is `wss`.

import type { HostLinks } from "@miyoria/contracts/host";
import type { LinkPlaceholder } from "./catalog.js";

/** `ws(s)://<host of clusterUrl>:<port><path>`; `null` without a usable cluster URL. */
export function linkUrl(clusterUrl: string | undefined, port: number, path: string): string | null {
  if (clusterUrl === undefined || clusterUrl === "") return null;
  try {
    const url = new URL(clusterUrl);
    const scheme = url.protocol === "wss:" || url.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${url.hostname}:${port}${path}`;
  } catch {
    return null;
  }
}

/** The `{link:...}` values for what Core sent; a value that cannot be known is left out. */
export function linkValues(
  links: HostLinks["links"],
  clusterUrl: string | undefined,
): Partial<Record<LinkPlaceholder, string>> {
  const out: Partial<Record<LinkPlaceholder, string>> = {};
  for (const kind of ["voice", "stage"] as const) {
    const link = links[kind];
    if (link === undefined) continue;
    const url = link.url ?? linkUrl(clusterUrl, link.port, link.path);
    if (url !== null && url !== "") out[`${kind}.url`] = url;
    if (link.token !== "") out[`${kind}.token`] = link.token;
  }
  return out;
}
