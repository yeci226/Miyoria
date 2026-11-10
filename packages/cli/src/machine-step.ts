// `miyoria init`: which services this computer runs, and where the other computers are. Writes the
// `[machine]` section and the concrete addresses it implies (binds, core_url, ASR_URL ...), so
// nothing has to be edited by hand when the roles are split across computers.

import type { Prompter } from "./prompt.js";
import * as settings from "./settings.js";
import { WORKER_PORTS } from "./stack/config.js";
import {
  expandTargets,
  isLoopback,
  LOOPBACK,
  ROLE_NAMES,
  ROLES,
  type Role,
  rolesCovered,
  SERVICE_ORDER,
  type ServiceName,
  servicesOfRoles,
} from "./stack/roles.js";
import type { TomlValue } from "./toml-patch.js";
import type { Workspace } from "./workspace.js";

export interface MachinePreset {
  /** `--roles`: a role, a list of roles / services, or `all`. */
  roles?: string;
  coreHost?: string;
  inferenceHost?: string;
}

export interface MachineResult {
  services: ServiceName[];
  roles: Role[];
  custom: boolean;
  coreHost: string;
  inferenceHost: string;
}

const hostCheck = (s: string): string | null =>
  /^[A-Za-z0-9.-]+$/.test(s.trim()) ? null : "要是 IP 位址或主機名稱,例如 192.168.1.20";

function stringList(v: TomlValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** What the config says now, for the defaults of the questions. */
export function currentMachine(ws: Workspace): {
  services: ServiceName[] | null;
  custom: boolean;
  coreHost: string;
  inferenceHost: string;
} {
  const roles = stringList(ws.item("machine.roles")).filter((r): r is Role =>
    (ROLE_NAMES as string[]).includes(r),
  );
  const listed = stringList(ws.item("machine.services")).filter((s): s is ServiceName =>
    (SERVICE_ORDER as readonly string[]).includes(s),
  );
  const host = (k: string) => {
    const v = ws.item(`machine.hosts.${k}`);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : LOOPBACK;
  };
  const custom = listed.length > 0;
  const services = custom
    ? SERVICE_ORDER.filter((s) => listed.includes(s))
    : servicesOfRoles(roles);
  return {
    services: custom || roles.length > 0 ? services : null,
    custom,
    coreHost: host("core"),
    inferenceHost: host("inference"),
  };
}

const PRESETS = [
  { label: "全部都在這台電腦(單機;要 NVIDIA 顯卡和模型)", roles: ROLE_NAMES as readonly Role[] },
  ...ROLE_NAMES.map((r) => ({
    label: `只有${ROLES[r].label}(${r}):${ROLES[r].help}`,
    roles: [r] as readonly Role[],
  })),
];
const CUSTOM = PRESETS.length;

/** Picks the services (a preset, or one by one) and returns them with the roles they make up. */
async function pickServices(
  p: Prompter,
  now: ReturnType<typeof currentMachine>,
  preset: MachinePreset,
): Promise<{ services: ServiceName[]; roles: Role[]; custom: boolean }> {
  if (preset.roles !== undefined) {
    const services = expandTargets([preset.roles]);
    const named = preset.roles.split(",").map((s) => s.trim());
    const onlyRoles = named.every((n) => n === "all" || (ROLE_NAMES as string[]).includes(n));
    const roles = onlyRoles ? rolesCovered(services) : [];
    return { services, roles, custom: !onlyRoles };
  }
  let initial = 2; // a new install starts with text chat only: no GPU, no models
  if (now.services !== null) {
    const same = PRESETS.findIndex(
      (x) => servicesOfRoles(x.roles).join() === now.services?.join() && !now.custom,
    );
    initial = same >= 0 ? same : CUSTOM;
  }
  const choice = await p.select(
    "這台電腦要跑哪些服務?(之後可以重新執行 init 改)",
    [...PRESETS.map((x) => x.label), "自訂:自己挑服務"],
    initial,
  );
  const picked = PRESETS[choice];
  if (picked)
    return { services: servicesOfRoles(picked.roles), roles: [...picked.roles], custom: false };
  const services: ServiceName[] = [];
  for (const s of SERVICE_ORDER) {
    const was = now.services?.includes(s) ?? true;
    if (await p.confirm(`在這台電腦跑 ${s}?`, was)) services.push(s);
  }
  return { services, roles: [], custom: true };
}

/** The questions and the writes. Returns what was chosen. */
export async function machineStep(
  p: Prompter,
  ws: Workspace,
  preset: MachinePreset = {},
): Promise<MachineResult> {
  const now = currentMachine(ws);
  const { services, roles, custom } = await pickServices(p, now, preset);
  if (services.length === 0) throw new Error("沒有選任何服務");
  const here = (s: ServiceName) => services.includes(s);
  const everything = services.length === SERVICE_ORDER.length;

  let coreHost = preset.coreHost ?? now.coreHost;
  let inferenceHost = preset.inferenceHost ?? now.inferenceHost;
  if (everything) {
    coreHost = LOOPBACK;
    inferenceHost = LOOPBACK;
  } else {
    if (preset.coreHost === undefined) {
      coreHost = (
        await p.text(
          here("core")
            ? "這台電腦的區網位址(別台電腦用它連到 core;只有這台電腦用就留 127.0.0.1)"
            : "跑 core 的那台電腦的區網位址",
          coreHost,
          hostCheck,
        )
      ).trim();
    }
    if (preset.inferenceHost === undefined) {
      inferenceHost = (
        await p.text(
          here("asr") || here("tts") || here("sing")
            ? "這台電腦的區網位址(core 用它連 asr / tts / sing;只有這台電腦用就留 127.0.0.1)"
            : "跑 asr / tts / sing 的那台電腦的區網位址",
          inferenceHost,
          hostCheck,
        )
      ).trim();
    }
  }

  // [machine]
  if (custom) {
    ws.set("machine.services", services);
    ws.unset("machine.roles");
  } else {
    ws.set("machine.roles", roles);
    ws.unset("machine.services");
  }
  ws.set("machine.hosts.core", coreHost);
  ws.set("machine.hosts.inference", inferenceHost);

  applyAddresses(ws, services, coreHost, inferenceHost);
  p.note(
    everything
      ? "全部都在這台電腦:位址都用 127.0.0.1"
      : `位址已寫入:core ${coreHost}、asr / tts / sing ${inferenceHost}(兩台以上電腦要確認防火牆有放行這些埠)`,
  );
  return { services, roles, custom, coreHost, inferenceHost };
}

/** The addresses the selected services need, written where they are read. */
export function applyAddresses(
  ws: Workspace,
  services: readonly ServiceName[],
  coreHost: string,
  inferenceHost: string,
): void {
  const here = (s: ServiceName) => services.includes(s);
  const portOf = (key: string, fallback: number): number => {
    const v = ws.effective(key);
    const m = v ? /:(\d+)$/.exec(v) : null;
    return m ? Number(m[1]) : fallback;
  };

  if (here("core") && !isLoopback(coreHost)) {
    for (const [id, port] of [
      ["api", 7878],
      ["voice.link", 7879],
      ["stage.link", 7882],
    ] as const) {
      const key = `modules.${id.includes(".") ? `"${id}"` : id}.bind`;
      ws.set(key, `${coreHost}:${portOf(key, port)}`);
    }
  }
  if (here("stage")) {
    const port = portOf('modules."stage.link".bind', 7882);
    ws.set("stage.core_url", `ws://${coreHost}:${port}/stage-link`);
  }
  if (here("core")) {
    ws.setEnv("ASR_URL", `http://${inferenceHost}:${WORKER_PORTS.asr}`);
    ws.setEnv("TTS_URL", `http://${inferenceHost}:${WORKER_PORTS.tts}`);
    if (!isLoopback(inferenceHost) || ws.item("modules.sing.url") !== undefined) {
      ws.set("modules.sing.url", `http://${inferenceHost}:${WORKER_PORTS.sing}`);
    }
  }
}

/**
 * A computer without core still needs the link tokens core made; they are pasted, not generated
 * (a token made here would not match core's). Blank keeps what is set.
 */
export async function pasteTokens(
  p: Prompter,
  ws: Workspace,
  services: readonly ServiceName[],
): Promise<string[]> {
  const asked: string[] = [];
  const wanted: Array<[string, string, string[]]> = [];
  if (services.includes("stage")) {
    wanted.push([
      "STAGE_LINK_TOKEN",
      "core 的 STAGE_LINK_TOKEN(stage 連 core 用)",
      ["stage.token"],
    ]);
  }
  if (services.includes("voice-node")) {
    wanted.push([
      "VOICE_LINK_TOKEN",
      "core 的 VOICE_LINK_TOKEN(voice node 連 core 用;apps/voice-node/.env 也要填同一個)",
      [],
    ]);
  }
  for (const [variable, label, keys] of wanted) {
    const have = ws.lookup(variable)?.[0] ?? "";
    const typed = (await p.secret(settings.secretLabel(label, have !== ""))).trim();
    if (typed !== "") {
      ws.setEnv(variable, typed);
      asked.push(variable);
    }
    for (const key of keys) {
      if (ws.item(key) === undefined) ws.set(key, `\${${variable}:-}`);
    }
  }
  return asked;
}
