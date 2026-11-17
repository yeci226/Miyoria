// The JSON-RPC 2.0 envelope the protocol rides on. Messages are JSON bodies in
// `Content-Length` frames over the extension's stdin and stdout.

import { z } from "zod";

/** A request id. The host numbers its requests; an extension may use strings. */
export const ExtRpcIdSchema = z.union([z.number(), z.string()]).meta({ id: "ExtRpcId" });
export type ExtRpcId = z.output<typeof ExtRpcIdSchema>;

/** The `error` of a response. `data` is free; failed tasks carry `{ code }` in it. */
export const ExtRpcErrorObjectSchema = z
  .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
  .meta({ id: "ExtRpcErrorObject" });
export type ExtRpcErrorObject = z.output<typeof ExtRpcErrorObjectSchema>;

/**
 * Any message on the wire: a request (has `id` and `method`), a notification (`method` only), a
 * result or an error (`id` and `result` or `error`). A response to a request that could not be
 * read has `id: null`.
 */
export const ExtRpcMessageSchema = z
  .union([
    z.object({
      jsonrpc: z.literal("2.0"),
      id: ExtRpcIdSchema,
      method: z.string(),
      params: z.unknown().optional(),
    }),
    z.object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown().optional() }),
    z.object({
      jsonrpc: z.literal("2.0"),
      id: z.union([ExtRpcIdSchema, z.null()]),
      result: z.unknown().optional(),
    }),
    z.object({
      jsonrpc: z.literal("2.0"),
      id: z.union([ExtRpcIdSchema, z.null()]),
      error: ExtRpcErrorObjectSchema,
    }),
  ])
  .meta({ id: "ExtRpcMessage" });
export type ExtRpcMessage = z.output<typeof ExtRpcMessageSchema>;
