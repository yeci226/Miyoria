// Short tickets the member site hands to the file origin. The file origin has no cookies, so it
// cannot see who is logged in; for a link that is for one person or a server's members, the member
// site checks the session and sends the browser on with a ticket naming who they are, for this
// one share and for two minutes. A member's own download is a ticket for one artifact.
//
// A ticket is `<payload>.<mac>`, both base64url: the payload names the kind (`s`: a share,
// `d`: an artifact), its id, the person and the expiry; the mac is HMAC-SHA256 under a key made
// when the module starts (a restart only voids tickets of the last two minutes). Verifying compares
// the mac in constant time and refuses another kind, another id, an expired or a malformed ticket.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PersonId } from "@miyoria/types";

/** What a ticket opens: one share (`s`), or one of the person's own artifacts (`d`). */
export type TicketKind = "s" | "d";

/** How long a ticket opens its file. */
export const TICKET_TTL_MS = 120_000;

const PART = /^[A-Za-z0-9_-]{1,512}$/;

interface Payload {
  k: TicketKind;
  i: string;
  p: string;
  x: number;
}

export class Tickets {
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(now: () => number, key: Buffer = randomBytes(32), ttlMs = TICKET_TTL_MS) {
    if (key.length < 32) throw new Error("a ticket key needs 32 bytes or more");
    this.#key = key;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  #mac(payload: string): Buffer {
    return createHmac("sha256", this.#key).update(payload, "utf8").digest();
  }

  /** A ticket for `person` to open `id` of `kind`. */
  issue(kind: TicketKind, id: string, person: PersonId): string {
    const payload: Payload = { k: kind, i: id, p: person, x: this.#now() + this.#ttlMs };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${body}.${this.#mac(body).toString("base64url")}`;
  }

  /** The person a ticket names, when it is genuine, unexpired and for `kind` and `id`. */
  verify(ticket: unknown, kind: TicketKind, id: string): PersonId | null {
    if (typeof ticket !== "string" || ticket.length > 1100) return null;
    const [body, mac, extra] = ticket.split(".");
    if (extra !== undefined || body === undefined || mac === undefined) return null;
    if (!PART.test(body) || !PART.test(mac)) return null;
    const want = this.#mac(body);
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let payload: Partial<Payload>;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Payload>;
    } catch {
      return null;
    }
    if (payload.k !== kind || payload.i !== id || typeof payload.p !== "string") return null;
    if (typeof payload.x !== "number" || payload.x <= this.#now()) return null;
    return payload.p as PersonId;
  }
}
