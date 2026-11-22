// A member's own GitHub link (module `report`): whether they linked an account, under which login,
// and their switch for being named on the issues their reports become. Linking itself is a browser
// round trip through GitHub, not on this table: `GET /api/member/github/link?mention=1|0` starts it
// and `GET /api/member/github/callback` finishes it, both sending the browser back to `/me` with
// `?github=<outcome>`. Every route needs a member session; without the `report` module, or with
// the App's user authorisation not set, `available` is false.

import { z } from "zod";
import { route } from "./route.js";

export const GithubLinkViewSchema = z
  .object({
    /** Linking is set up on this Core (the App's client id, secret and callback). */
    available: z.boolean(),
    linked: z
      .object({
        /** The login GitHub gave when it was last read. */
        login: z.string(),
        /** 「在我回報的問題上標記我」 */
        mention: z.boolean(),
        linked_at: z.string(),
      })
      .nullable(),
  })
  .meta({ id: "ApiGithubLinkView" });
export type GithubLinkView = z.output<typeof GithubLinkViewSchema>;

export const GithubMentionRequestSchema = z
  .object({ on: z.boolean() })
  .meta({ id: "ApiGithubMentionRequest" });
export type GithubMentionRequest = z.input<typeof GithubMentionRequestSchema>;

const member = () => route.meta({ audience: "member", permission: null, limited: true });

export const githubLink = {
  status: member()
    .route({ method: "GET", path: "/api/member/github" })
    .output(GithubLinkViewSchema),
  /** `404` without a link. */
  mention: member()
    .route({ method: "POST", path: "/api/member/github/mention" })
    .input(z.object({ body: GithubMentionRequestSchema }))
    .output(GithubLinkViewSchema),
  /** Removes the link; nothing on GitHub changes. Unlinked already: the same answer. */
  unlink: member()
    .route({ method: "POST", path: "/api/member/github/unlink" })
    .output(GithubLinkViewSchema),
};
