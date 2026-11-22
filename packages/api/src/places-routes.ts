// The Spaces for the space pickers (contracts `spaces.ts`, docs/design/v5-places.md §6):
//
// * `GET /api/places/spaces` (admin): every Space she is in, with the primary flag and the number
//   of members, and the default an admin page uses (`adminSpace`).
// * `GET /api/member/spaces` (member): the logged-in person's own Spaces and the default a member
//   route uses (`memberSpace`).

import type { AdminSpaces, MemberSpaces, Space } from "@miyoria/contracts/api";
import type { SpaceRef } from "@miyoria/types";
import { os } from "./contract.js";
import { adminSpace, memberPerson, memberSpace, placesOf } from "./space-param.js";
import type { ApiContext, ApiState } from "./state.js";

function spaceView(space: SpaceRef): Space {
  return {
    id: space.id,
    platform: space.platform,
    external_id: space.external_id,
    name: space.name,
    primary: space.primary,
    established: space.established,
  };
}

function adminSpaces(state: ApiState): AdminSpaces {
  const places = placesOf(state);
  return {
    spaces: places.spaces().map((s) => ({ ...spaceView(s), members: places.members(s.id).size })),
    default: adminSpace(state)?.id ?? null,
  };
}

async function memberSpaces(state: ApiState, c: ApiContext): Promise<MemberSpaces> {
  const places = placesOf(state);
  const person = await memberPerson(state, c);
  const spaces = person === null ? [] : places.spacesOf(person);
  let fallback: string | null = null;
  try {
    fallback = memberSpace(state, person).id;
  } catch {
    // She is in no Space: there is no default.
  }
  return { spaces: spaces.map(spaceView), default: fallback };
}

export const placesSpacesRpc = {
  spaces: os.places.spaces.handler(({ context }) => adminSpaces(context.state)),
};

export const memberSpacesRpc = {
  spaces: os.member.spaces.handler(({ context }) => memberSpaces(context.state, context.c)),
};
