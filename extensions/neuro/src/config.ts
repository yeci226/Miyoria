// `[extensions."miyoria.neuro"]` (config.schema.json). Parsed once with defaults; a bad value
// fails activation with the field named, rather than silently binding somewhere unexpected.

import { z } from "zod";

export const DEFAULT_PORT = 8000;
export const DEFAULT_HOST = "127.0.0.1";

const ConfigSchema = z.object({
  /** Off unless set: the host's own `enabled` defaults to true, so it cannot be the guard. */
  serve: z.boolean().default(false),
  host: z.string().min(1).default(DEFAULT_HOST),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  games: z.array(z.string()).default([]),
  character_id: z.string().min(1).max(64).default("neuro"),
  display_name: z.string().min(1).max(64).default("Miyoria"),
  result_timeout_s: z.number().min(0.1).max(600).default(20),
  force_timeout_s: z.number().min(0.1).max(3600).default(120),
  force_max_attempts: z.number().int().min(1).max(50).default(5),
  context_keep: z.number().int().min(1).max(100).default(12),
  max_actions: z.number().int().min(1).max(64).default(48),
  ping_interval_ms: z.number().int().min(100).default(15_000),
});

export type NeuroConfig = z.output<typeof ConfigSchema>;

export function parseConfig(raw: Record<string, unknown>): NeuroConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`invalid miyoria.neuro config: ${problems.join("; ")}`);
}

/** Loopback addresses: `127.0.0.0/8`, `::1`, `localhost`. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
