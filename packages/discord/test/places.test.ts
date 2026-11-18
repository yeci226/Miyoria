import { describe, expect, it } from "vitest";
import { type ChannelView, type GuildView, placeRooms } from "../src/places.js";

const ch = (c: Partial<ChannelView> & Pick<ChannelView, "id" | "name">): ChannelView => ({
  kind: "text",
  parent: null,
  position: 0,
  view: true,
  use: true,
  ...c,
});

const GUILD: GuildView = {
  id: "100",
  name: "魚缸",
  channels: [
    ch({ id: "c2", name: "活動", kind: "category", position: 2 }),
    ch({ id: "c1", name: "聊天", kind: "category", position: 1 }),
    ch({ id: "t3", name: "公告", parent: "c2", position: 0 }),
    ch({ id: "t1", name: "閒聊", parent: "c1", position: 1 }),
    ch({ id: "t2", name: "規則", position: 0, use: false }),
    ch({ id: "v1", name: "語音", kind: "voice", parent: "c1", position: 0 }),
    ch({ id: "t4", name: "秘密", parent: "c1", position: 2, view: false }),
  ],
};

describe("placeRooms", () => {
  it("lists rooms in the server's order with their category, context key and use", () => {
    const rooms = placeRooms([GUILD]);
    expect(rooms.map((r) => r.id)).toEqual(["t2", "t1", "t4", "v1", "t3"]);
    expect(rooms[1]).toMatchObject({
      context: "discord:100:t1",
      category: { id: "c1", name: "聊天" },
      space: { id: "100", name: "魚缸" },
      usable: true,
      reason: null,
    });
    expect(rooms.find((r) => r.id === "v1")?.context).toBe("discord:100:voice:v1");
    expect(rooms.find((r) => r.id === "t2")?.reason).toBe("她不能在這裡發言");
    expect(rooms.find((r) => r.id === "t4")?.reason).toBe("她看不到這個頻道");
  });

  it("filters by kind and by server", () => {
    expect(placeRooms([GUILD], { kind: "voice" }).map((r) => r.id)).toEqual(["v1"]);
    expect(placeRooms([GUILD], { space: "other" })).toEqual([]);
  });
});
