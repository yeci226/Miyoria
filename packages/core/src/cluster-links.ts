// Where Core's node links listen, for `cluster.links` (docs/design/v5-hostd.md §6.4, H4b): the
// `cluster` module tells a host approved for `voice-room` where `voice.link` is and its token, and
// one approved for `renderer` the same of `stage.link`, so a joined machine's voice node and stage
// need neither written by hand. hostd builds the address from its own `[cluster] url` (Core's host
// name as that machine reaches it) with the port and path here, unless `[modules.cluster]
// public_url` is set: then its host and scheme are used, with the link's own port and path.
//
// A link whose module is turned off, whose token is empty (the module would not start) or whose
// bind does not parse is left out.

import { ClusterConfigSchema, type ClusterLinksSource } from "@miyoria/cluster";
import type { Config } from "@miyoria/runtime/kernel";
import { STAGE_LINK_PATH, StageLinkConfigSchema, StageLinkModule } from "@miyoria/stage";
import { isJsonObject } from "@miyoria/types";
import { VOICE_LINK_PATH, VoiceLinkConfigSchema, VoiceLinkModule } from "@miyoria/voice/voice";

/** `cluster.links` params' `links`, as the cluster module takes them. */
type HostLinks = ReturnType<ClusterLinksSource>;
type HostLinkValues = NonNullable<HostLinks["voice"]>;

/** The port of a `host:port` / `[v6]:port` bind; `null` when it does not parse. */
function bindPort(bind: string): number | null {
  const m = /^(?:\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(bind.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** `ws(s)://<public host>:<port><path>` from `[modules.cluster] public_url`; `null` without one. */
function publicLinkUrl(publicUrl: string | undefined, port: number, path: string): string | null {
  if (publicUrl === undefined) return null;
  try {
    const url = new URL(publicUrl);
    return `${url.protocol}//${url.hostname}:${port}${path}`;
  } catch {
    return null;
  }
}

/** The values of one link module from `config`, or `null` when it is left out. */
function linkValues(
  config: Config,
  id: string,
  read: (section: unknown) => { bind: string; token: string } | null,
  path: string,
  publicUrl: string | undefined,
): HostLinkValues | null {
  const section = config.module(id);
  if (!section.enabled) return null;
  const parsed = read(section.config ?? {});
  if (parsed === null) return null;
  const token = parsed.token.trim();
  const port = bindPort(parsed.bind);
  if (token === "" || port === null) return null;
  const url = publicLinkUrl(publicUrl, port, path);
  return { ...(url === null ? {} : { url }), port, path, token };
}

/** What `cluster.links` carries for this config (before the cluster module picks per host). */
export function clusterLinks(config: Config): HostLinks {
  const cluster = config.module("cluster").config;
  const parsedCluster = ClusterConfigSchema.safeParse(isJsonObject(cluster) ? cluster : {});
  const publicUrl = parsedCluster.success ? parsedCluster.data.public_url : undefined;
  const voice = linkValues(
    config,
    VoiceLinkModule.ID,
    (section) => {
      const r = VoiceLinkConfigSchema.safeParse(section);
      return r.success ? r.data : null;
    },
    VOICE_LINK_PATH,
    publicUrl,
  );
  const stage = linkValues(
    config,
    StageLinkModule.ID,
    (section) => {
      const r = StageLinkConfigSchema.safeParse(section);
      return r.success ? r.data : null;
    },
    STAGE_LINK_PATH,
    publicUrl,
  );
  return {
    ...(voice === null ? {} : { voice }),
    ...(stage === null ? {} : { stage }),
  };
}
