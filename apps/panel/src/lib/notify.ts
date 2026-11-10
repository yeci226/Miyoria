// Mutation feedback through Sonner. Errors stay a little longer; dialogs stay open on failure
// (callers close them in `onSuccess` only).

import { toast } from "sonner";
import { describeError } from "@/api/http";

export const notify = {
  ok: (message: string) => toast.success(message),
  /** A neutral notice: not an error, not a success. */
  info: (message: string) => toast(message),
  warn: (message: string) => toast.warning(message, { duration: 8_000 }),
  error: (error: unknown, what?: string) =>
    toast.error(what ? `${what}:${describeError(error)}` : describeError(error), {
      duration: 8_000,
    }),
};
