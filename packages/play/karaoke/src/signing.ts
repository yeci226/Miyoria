// The short-lived links to a session's files (docs/design/karaoke.md §13.3): the backing track and
// the reference are served only through a member route, and only with a signature over the
// session, the file, the member's account and the moment it stops working. The key is made when
// the module starts, so a restart ends every link; a link is good for `LINK_MS`, except the
// background video's, which is read in ranges while it plays and lasts its session.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountRef, KaraokeFileName } from "@miyoria/types";

/** How long a link works. */
export const LINK_MS = 10 * 60_000;

/** The member route the links point at (`packages/api`). */
export const FILE_ROUTE = "/api/member/karaoke/files";

export class FileSigner {
  readonly #key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.#key = key;
  }

  #sign(session: string, name: string, account: AccountRef, exp: number): string {
    return createHmac("sha256", this.#key)
      .update(`${session}\n${name}\n${account.platform}:${account.id}\n${exp}`)
      .digest("base64url");
  }

  /** The link to `name` of `session` for `account`, working until `exp` (epoch ms). */
  url(session: string, name: KaraokeFileName, account: AccountRef, exp: number): string {
    const sig = this.#sign(session, name, account, exp);
    return `${FILE_ROUTE}/${encodeURIComponent(session)}/${name}?exp=${exp}&sig=${sig}`;
  }

  /**
   * Whether a link's `exp` and `sig` are this module's for `account`, and still good at `now`. A
   * link that claims to last longer than `longestMs` from now is not one of them.
   */
  check(
    session: string,
    name: string,
    account: AccountRef,
    exp: string | undefined,
    sig: string | undefined,
    now: number,
    longestMs = LINK_MS * 2,
  ): boolean {
    if (exp === undefined || sig === undefined || !/^\d{1,16}$/.test(exp)) return false;
    const when = Number(exp);
    if (when < now || when > now + longestMs) return false;
    const want = Buffer.from(this.#sign(session, name, account, when));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
