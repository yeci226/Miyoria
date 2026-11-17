// `web_image` with fake transports (no network): the same guard as a page, a byte cap, the byte
// sniff, its own rate limits, and the picture reaching the model beside a short text.

import { ActuatorRegistry, type CapabilityTool } from "@miyoria/gate/actions";
import type { ToolResult } from "@miyoria/llm/tools";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type AccountRef, AuthorizerKey, type ContextKey, Principals } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { WebConfigSchema } from "../src/config.js";
import { WebError } from "../src/net.js";
import { WEB_NODE, webCapabilities } from "../src/tools.js";
import { NO_IMAGES, WebService } from "../src/web.js";
import { fakeTransport, resolver, response } from "./helpers.js";

const ALICE = "discord:1";
const BOB = "discord:2";
const signal = () => new AbortController().signal;

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (size = 64) => {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set(PNG_HEAD);
  return bytes;
};
const image = (body: Uint8Array | string, type = "image/png") =>
  response(200, body, { "content-type": type });

function rig(
  over: Record<string, unknown> = {},
  pages: Parameters<typeof fakeTransport>[0] = {},
  options: { takes?: boolean; table?: Record<string, string[]> } = {},
) {
  const transport = fakeTransport(pages);
  const web = new WebService({
    config: WebConfigSchema.parse(over),
    clock: { now: () => 1_000_000 },
    resolve: resolver(options.table),
    transport,
    takesImages: () => options.takes ?? true,
  });
  return { web, transport };
}

const OK = "https://img.example/a.png";
const pages = { [OK]: () => image(png()) };

describe("web_image download", () => {
  it("returns the bytes as downloaded, as a data URL, with what they are", async () => {
    const r = rig({}, pages);
    const out = await r.web.image(ALICE, OK, signal());
    expect(out).toMatchObject({ url: OK, type: "image/png", bytes: 64 });
    expect(out.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png()).toString("base64")}`);
    expect(r.transport.calls[0]?.headers.accept).toContain("image/png");
  });

  it("goes by the bytes, not by the name or the type the server says", async () => {
    const jpeg = new Uint8Array(32).fill(1);
    jpeg.set([0xff, 0xd8, 0xff]);
    const r = rig(
      {},
      {
        "https://img.example/x.png": () => image(jpeg, "image/png"),
        "https://img.example/raw": () => image(png(), "application/octet-stream"),
        "https://img.example/fake.png": () => image("<html>login</html>", "image/png"),
      },
    );
    expect((await r.web.image(ALICE, "https://img.example/x.png", signal())).type).toBe(
      "image/jpeg",
    );
    expect((await r.web.image(ALICE, "https://img.example/raw", signal())).type).toBe("image/png");
    await expect(r.web.image(ALICE, "https://img.example/fake.png", signal())).rejects.toThrow(
      /不是圖片/,
    );
  });

  it("refuses private addresses, names that resolve to them, and a redirect into them", async () => {
    const r = rig(
      {},
      {
        "https://img.example/hop.png": () =>
          response(302, "", { location: "http://169.254.169.254/latest/a.png" }),
      },
      { table: { "evil.example": ["10.0.0.5"] } },
    );
    for (const url of [
      "http://127.0.0.1/a.png",
      "http://[::1]/a.png",
      "http://192.168.1.2/a.png",
      "https://evil.example/a.png",
      "https://img.example/hop.png",
      "http://localhost/a.png",
      "file:///etc/passwd",
    ]) {
      await expect(r.web.image(ALICE, url, signal()), url).rejects.toThrow(WebError);
    }
    // Only the first hop of the redirect was ever contacted.
    expect(r.transport.calls.map((c) => c.url.href)).toEqual(["https://img.example/hop.png"]);
  });

  it("refuses what is not an image", async () => {
    const r = rig(
      {},
      {
        "https://img.example/page": () =>
          response(200, "<html></html>", { "content-type": "text/html" }),
        "https://img.example/doc.pdf": () => image(png(), "application/pdf"),
        "https://img.example/svg": () => image("<svg/>", "image/svg+xml"),
      },
    );
    for (const url of ["page", "doc.pdf", "svg"]) {
      await expect(r.web.image(ALICE, `https://img.example/${url}`, signal()), url).rejects.toThrow(
        /不是圖片/,
      );
    }
  });

  it("refuses a file over image_max_bytes and takes one exactly at it", async () => {
    const r = rig(
      { image_max_bytes: 10_000 },
      {
        "https://img.example/big.png": () => image(png(10_001)),
        "https://img.example/edge.png": () => image(png(10_000)),
        // The body arrives in pieces: the cap stops the read, not the end of the stream.
        "https://img.example/stream.png": () =>
          response(200, [png(6_000), new Uint8Array(6_000).fill(1)], {
            "content-type": "image/png",
          }),
      },
    );
    await expect(r.web.image(ALICE, "https://img.example/big.png", signal())).rejects.toThrow(
      /太大/,
    );
    await expect(r.web.image(ALICE, "https://img.example/stream.png", signal())).rejects.toThrow(
      /太大/,
    );
    expect((await r.web.image(ALICE, "https://img.example/edge.png", signal())).bytes).toBe(10_000);
  });

  it("downloads nothing when the chat model takes no images, and spends no limit", async () => {
    const r = rig({ image_per_person: 1 }, pages, { takes: false });
    await expect(r.web.image(ALICE, OK, signal())).rejects.toThrow(NO_IMAGES);
    expect(r.transport.calls).toEqual([]);
    const on = rig({ image_per_person: 1 }, pages);
    await expect(on.web.image(ALICE, OK, signal())).resolves.toBeDefined();
  });

  it("limits pictures per person and for everyone, apart from page reads", async () => {
    const r = rig({ image_per_person: 2, image_global: 3 }, pages);
    await r.web.image(ALICE, OK, signal());
    await r.web.image(ALICE, OK, signal());
    await expect(r.web.image(ALICE, OK, signal())).rejects.toThrow(/看太多張/);
    await r.web.image(BOB, OK, signal());
    await expect(r.web.image(BOB, OK, signal())).rejects.toThrow(/看太多張/);
    // A refusal by the guard still counts: it cost a lookup.
    expect(r.transport.calls).toHaveLength(3);
  });
});

describe("web_image through the gate", () => {
  const ctx: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
  const alice: AccountRef = { platform: "discord", id: "1" };

  it("hands the picture over beside a short text, never in the text", async () => {
    const services = new ServiceRegistry();
    services.provide("test", AuthorizerKey, {
      allows: (a: AccountRef, node: string) => a.id === alice.id && node === WEB_NODE,
    } as never);
    const registered = new Map<string, unknown>();
    const registry = new ActuatorRegistry({
      services,
      builtins: false,
      tools: {
        register: (t: { spec: { name: string } }) => registered.set(t.spec.name, t),
        get: (n: string) => registered.get(n),
        unregister: (n: string) => registered.delete(n),
      } as never,
    });
    for (const c of webCapabilities(rig({}, pages).web)) registry.register(c);
    const tool = registered.get("web_image") as CapabilityTool;
    const out = (await tool.result(
      {
        turn: "t1",
        context: ctx,
        account: alice,
        principal: Principals.user(alice, ctx),
        message: { context: ctx, id: "m1" },
        priority: "request",
        signal: signal(),
      },
      { url: OK },
    )) as ToolResult;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain("圖片已經看到了");
    expect(out.text).toContain(OK);
    expect(out.text).not.toContain("base64");
    expect(out.images).toHaveLength(1);
    expect(out.images?.[0]?.image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});
