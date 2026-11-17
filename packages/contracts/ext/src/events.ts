// The `event` notification: a bus event the host forwards to an extension that subscribed to its
// type and is granted it. Since protocol 2 its params carry the bus envelope as every live reader
// receives it (`BusEnvelopeSchema` in @miyoria/contracts/events): `type` is the dotted topic
// (`platform.message.created`), `data` the payload of that type's registered schema at `v`.
//
// The pattern that matched is not sent: an extension matches its own subscriptions against
// `envelope.type` (the SDK does), and the host sends each event once however many match.

import { z } from "zod";
import { BusEnvelopeSchema } from "../../events/src/envelope.js";

/** `event` params: the bus envelope, every key present (`null` when unset). */
export const ExtEventNotificationSchema = z
  .object({ envelope: BusEnvelopeSchema })
  .meta({ id: "ExtEventNotification" });
export type ExtEventNotification = z.output<typeof ExtEventNotificationSchema>;
