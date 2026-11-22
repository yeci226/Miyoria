// A member's own GitHub link (module `report`), on the member page.
//
// * Route table (`githubLink` group, a member session): `GET /api/member/github`,
//   `POST /api/member/github/mention` `{ on }`, `POST /api/member/github/unlink`.
// * Browser round trip (not on the table: redirects): `GET /api/member/github/link?mention=1|0`
//   starts the GitHub App's user authorisation with a single-use state and a short-lived HttpOnly
//   SameSite=Lax cookie tying it to this browser; `GET /api/member/github/callback` finishes it
//   (`GitHubLinker`) and sends the browser back to `/me?github=<outcome>`: `linked`, `taken` (that
//   account is linked to someone else: refused, never moved), `state`, `cancelled`, `exchange`,
//   `unknown` (she does not know them yet), `off`.
//
// Only GitHub's numeric id and login are kept; the user token never leaves the linker. Link and
// unlink are written to the audit log as the member.

import { type GitHubLinker, LINK_COOKIE, LINK_TTL_MS, ReportKey } from "@miyoria/brain/report";
import type { GithubLinkView } from "@miyoria/contracts/api";
import { PeopleStoreKey } from "@miyoria/store";
import { accountRefString, type PersonId } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { found, requestCookies } from "./oauth.js";
import type { Route } from "./route.js";
import { cookieValue, type SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";

/** Where the browser goes back to. */
export const MEMBER_PAGE = "/me";
const COOKIE_PATH = "/api/member/github";

function record(c: ApiContext): SessionRecord {
  return c.get("member");
}

function linker(state: ApiState): GitHubLinker | null {
  return state.optional(ReportKey)?.linker ?? null;
}

async function personOf(state: ApiState, c: ApiContext): Promise<PersonId | null> {
  const person = await state.optional(PeopleStoreKey)?.personByAccount(record(c).account);
  return person?.id ?? null;
}

function view(state: ApiState, person: PersonId | null): GithubLinkView {
  const reports = state.optional(ReportKey);
  const available = (reports?.linker ?? null) !== null;
  const link = reports !== undefined && person !== null ? reports.linkOf(person) : null;
  return {
    available,
    linked:
      link === null
        ? null
        : { login: link.login, mention: link.mention, linked_at: link.linked_at },
  };
}

/** `Set-Cookie` for the link's binding; an empty one deletes it. */
function bindingCookie(binding: string, secure: boolean): string {
  const maxAge = binding === "" ? 0 : Math.floor(LINK_TTL_MS / 1000);
  return `${LINK_COOKIE}=${binding}; Max-Age=${maxAge}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

const back = (outcome: string, ...cookies: string[]) =>
  found(`${MEMBER_PAGE}?github=${encodeURIComponent(outcome)}`, ...cookies);

/** `GET /api/member/github/link`: off to GitHub. */
async function start(state: ApiState, c: ApiContext): Promise<Response> {
  const link = linker(state);
  if (link === null) return back("off");
  const account = record(c).account;
  const actor = accountRefString(account);
  const wait = state.publicSide.admitHeavy(actor);
  if (wait !== null) throw ApiError.tooMany(wait);
  const person = await personOf(state, c);
  if (person === null) return back("unknown");
  const mention = c.req.query("mention") !== "0";
  const { url, binding } = link.begin(person, account, mention);
  return found(url, bindingCookie(binding, link.secure || state.auth.cookieSecure));
}

/** `GET /api/member/github/callback`: back from GitHub. */
async function callback(state: ApiState, c: ApiContext): Promise<Response> {
  const link = linker(state);
  if (link === null) return back("off");
  const secure = link.secure || state.auth.cookieSecure;
  const account = record(c).account;
  const actor = accountRefString(account);
  const done = await link.finish({
    state: c.req.query("state") ?? null,
    binding: cookieValue(requestCookies(c), LINK_COOKIE),
    code: c.req.query("code") ?? null,
    error: c.req.query("error") ?? null,
    account,
  });
  const clear = bindingCookie("", secure);
  if (!done.ok) {
    if (done.why !== "state" && done.why !== "cancelled") {
      await state.auditAs(actor, "member.github.link", actor, { refused: done.why }, false);
    }
    return back(done.why, clear);
  }
  await state.auditAs(actor, "member.github.link", actor, { login: done.login }, true);
  return back("linked", clear);
}

export function githubLinkRoutes(state: ApiState): Route[] {
  // Member pages, so they go with the public side's switch like the others.
  if (!state.publicSide.config.enabled) return [];
  const routes: Route[] = [
    { method: "GET", path: "/api/member/github/link", handler: (c) => start(state, c) },
    { method: "GET", path: "/api/member/github/callback", handler: (c) => callback(state, c) },
  ];
  return routes.map((r) => ({ ...r, member: true }));
}

export const githubLinkRpc = {
  status: os.githubLink.status.handler(async ({ context: { state, c } }) =>
    view(state, await personOf(state, c)),
  ),
  mention: os.githubLink.mention.handler(async ({ input, context: { state, c } }) => {
    const person = await personOf(state, c);
    const reports = state.service(ReportKey, "report module");
    if (person === null || !reports.setLinkMention(person, input.body.on)) {
      throw ApiError.notFound("沒有連結 GitHub 帳號");
    }
    return view(state, person);
  }),
  unlink: os.githubLink.unlink.handler(async ({ context: { state, c } }) => {
    const person = await personOf(state, c);
    const reports = state.service(ReportKey, "report module");
    if (person !== null && reports.unlink(person)) {
      const actor = accountRefString(record(c).account);
      await state.auditAs(actor, "member.github.unlink", actor, {}, true);
    }
    return view(state, person);
  }),
};
