// Where a turn happens, as the artifact store needs it: the place an artifact made there is
// recorded with, and the viewer a message sent there is seen by (`visibility.ts`).
//
// A platform context (`discord:<guild>:<channel>`, a DM channel) is looked up in identity's rooms.
// In a DM the viewer is the DM's person and nobody else, so an account that is not that person
// has no site there. In a guild room the viewer is whoever reads the room: the artifact's scope
// decides by the room and the space, and the person only says who asked.

import type { AccountRef, ContextKey, PersonId } from "@miyoria/types";
import { and, eq } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import { Identity } from "../identity/identity.js";
import { rooms } from "../identity/schema.js";
import type { ArtifactViewer } from "./visibility.js";

/** The place of a context, in the fields an ingest takes (`ArtifactInput.place`). */
export interface SitePlace {
  session: string;
  space_id: string | null;
  room_id: string;
}

/** A context as the artifact store sees it. */
export interface ArtifactSite {
  place: SitePlace;
  /** Who sees a message posted there. */
  viewer: ArtifactViewer;
  /** The person of the account asked about (in a DM: the DM's person); `null`: unknown. */
  person_id: PersonId | null;
  /** A DM: only its person sees what is posted there. */
  dm: boolean;
}

export interface SiteOptions {
  /**
   * Record a guild room identity has not seen yet (as the event log does for the first message
   * there). A DM is never created here: it exists only once its person wrote in it.
   */
  create?: boolean;
}

/** Looks contexts up in identity for the artifact store. */
export class ArtifactPlaces {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db) {
    this.#db = db;
    this.#identity = new Identity(db);
  }

  #room(context: ContextKey) {
    return this.#db.orm
      .select({
        id: rooms.id,
        space_id: rooms.space_id,
        parent_id: rooms.parent_id,
        dm_person: rooms.dm_person,
      })
      .from(rooms)
      .where(and(eq(rooms.platform, context.platform), eq(rooms.external_id, context.channel)))
      .get();
  }

  /**
   * The site of `context`; with `account`, for that account. `null` when identity does not know
   * the place, or when it is a DM and `account` is not the DM's person.
   */
  at(
    context: ContextKey,
    account: AccountRef | null = null,
    options: SiteOptions = {},
  ): ArtifactSite | null {
    this.#db.ensureOpen();
    let room = this.#room(context);
    if (room === undefined && options.create === true && context.scope !== null) {
      try {
        this.#identity.resolve(context, null);
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        return null;
      }
      room = this.#room(context);
    }
    if (room === undefined) return null;
    const session = this.#identity.sessionOf(context);
    if (session === null) return null;
    const asked = account === null ? null : (this.#identity.personOf(account)?.id ?? null);
    if (context.scope === null) {
      const person =
        room.dm_person === null ? null : (this.#identity.person(room.dm_person)?.id ?? null);
      if (person === null) return null;
      if (account !== null && asked !== person) return null;
      return {
        place: { session, space_id: null, room_id: room.id },
        viewer: { person_id: person, space_id: null, room_id: room.id },
        person_id: person,
        dm: true,
      };
    }
    if (room.space_id === null) return null;
    return {
      place: { session, space_id: room.space_id, room_id: room.id },
      viewer: {
        person_id: asked,
        space_id: room.space_id,
        room_id: room.id,
        parent_room_id: room.parent_id,
      },
      person_id: asked,
      dm: false,
    };
  }
}
