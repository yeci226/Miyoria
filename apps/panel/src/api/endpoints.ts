// The Admin API as the panel calls it: the route table (`@miyoria/contracts/api`) through `rpc` and
// `q` (`orpc.ts`), and the few routes that are not JSON and so not on the table: the logout and
// the Discord login redirect, and the downloads (`/api/member/export`, `/api/data/export`,
// `/api/data/backup`).

import type { ApiClient } from "./http";
import { createQueries, createRpc } from "./orpc";
import type { DataCategoryId } from "@miyoria/contracts/api";

export function createApi(client: ApiClient) {
  const rpc = createRpc(client);
  return {
    /** The route table's typed client: `api.rpc.persona.list()`. */
    rpc,
    /** Its TanStack Query helpers: `useQuery(api.q.health.queryOptions())`. */
    q: createQueries(rpc),

    // panel login
    /** Ends the Discord session (clears the cookie); harmless for the token. */
    logout: () => client.post<void>("/api/auth/logout", undefined, { public: true }),
    /** Where the browser goes to start a Discord login; `next` is a local path such as `/people`. */
    discordLoginUrl: (next: string) => client.url("/api/auth/oauth/login", { next }),

    // what anyone may see, and what a logged-in person has of their own: the cookie alone
    memberExportUrl: () => client.url("/api/member/export"),
    /** Where the browser goes to link the member's GitHub account (`mention`: name them on their reports). */
    githubLinkUrl: (mention: boolean) => client.url("/api/member/github/link", { mention: mention ? "1" : "0" }),

    // her data: the inventory and the deletes are on the route table, the downloads are not
    /** A JSON backup of `categories` (all exportable ones without). */
    dataExport: (categories?: DataCategoryId[]) =>
      client.download("GET", "/api/data/export", { query: { categories: categories?.join(",") } }),
    /** The full backup a reset needs; its `x-miyoria-backup-token` header unlocks the reset. */
    dataBackup: () => client.download("POST", "/api/data/backup"),
  };
}

export type Api = ReturnType<typeof createApi>;
