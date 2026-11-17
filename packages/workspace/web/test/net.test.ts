import { describe, expect, it } from "vitest";
import { WebConfigSchema } from "../src/config.js";
import {
  checkUrl,
  guardedGet,
  isBlockedAddress,
  parseIPv6,
  resolvePublic,
  WebError,
} from "../src/net.js";
import { fakeTransport, html, resolver, response } from "./helpers.js";

const config = WebConfigSchema.parse({});
const signal = () => new AbortController().signal;

describe("isBlockedAddress", () => {
  it.each([
    ["unspecified", "0.0.0.0"],
    ["this network", "0.1.2.3"],
    ["loopback", "127.0.0.1"],
    ["loopback high", "127.255.255.254"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12 low", "172.16.0.1"],
    ["private 172.16/12 high", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local / metadata", "169.254.169.254"],
    ["CGNAT low", "100.64.0.1"],
    ["CGNAT high", "100.127.255.255"],
    ["benchmarking", "198.18.0.1"],
    ["documentation", "203.0.113.5"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 loopback long", "0:0:0:0:0:0:0:1"],
    ["IPv6 ULA fc", "fc00::1"],
    ["IPv6 ULA fd", "fd12:3456:789a::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 link-local high", "febf::1"],
    ["IPv6 site-local", "fec0::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["IPv6 teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback hex", "::ffff:7f00:1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:a9fe:a9fe"],
    ["IPv4-compatible", "::127.0.0.1"],
    ["NAT64 of loopback", "64:ff9b::7f00:1"],
    ["NAT64 dotted", "64:ff9b::10.0.0.1"],
    ["6to4 of private", "2002:c0a8:101::1"],
    ["zone id", "fe80::1%eth0"],
    ["garbage", "not-an-ip"],
    ["octal-looking", "0177.0.0.1"],
    ["too many groups", "1:2:3:4:5:6:7:8:9"],
  ])("blocks %s (%s)", (_name, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("allows the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("parses IPv6 into eight groups", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6("1:2::3:4")).toEqual([1, 2, 0, 0, 0, 0, 3, 4]);
    expect(parseIPv6("1.2.3.4")).toBeNull();
  });
});

describe("checkUrl", () => {
  const refused = (url: string, allow: number[] = []) => {
    expect(() => checkUrl(url, allow), url).toThrow(WebError);
  };

  it("takes ordinary http and https pages", () => {
    expect(checkUrl("https://example.com/a?b=1#c").href).toBe("https://example.com/a?b=1#c");
    expect(checkUrl("http://example.com:80/").hostname).toBe("example.com");
    expect(checkUrl("https://example.com:443/").hostname).toBe("example.com");
    expect(checkUrl("https://93.184.216.34/").hostname).toBe("93.184.216.34");
    expect(checkUrl("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
  });

  it("refuses other schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "ws://example.com/",
      "not a url",
      "",
    ]) {
      refused(url);
    }
  });

  it("refuses credentials", () => {
    refused("https://user:pw@example.com/");
    refused("https://user@example.com/");
  });

  it("refuses localhost, bare and internal names", () => {
    for (const url of [
      "http://localhost/",
      "http://LOCALHOST:80/",
      "http://localhost./",
      "http://foo.localhost/",
      "http://intranet/",
      "http://printer/admin",
      "http://nas.local/",
      "http://db.internal/",
      "http://router.lan/",
    ]) {
      refused(url);
    }
  });

  it("refuses private IP literals in every spelling the URL parser normalizes", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.0.1/",
      "http://100.64.1.1/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[64:ff9b::7f00:1]/",
    ]) {
      refused(url);
    }
  });

  it("refuses other ports unless the config allows them", () => {
    refused("http://example.com:8080/");
    refused("https://example.com:22/");
    refused("http://example.com:6379/");
    expect(checkUrl("http://example.com:8080/", [8080]).port).toBe("8080");
    refused("http://example.com:8081/", [8080]);
  });
});

describe("resolvePublic (DNS)", () => {
  const url = (s: string) => new URL(s);

  it("returns the first public address", async () => {
    const got = await resolvePublic(
      url("https://a.example/"),
      resolver({ "a.example": ["1.2.3.4"] }),
    );
    expect(got).toEqual({ address: "1.2.3.4", family: 4 });
  });

  it("refuses a name that resolves to loopback or private space (rebinding style)", async () => {
    for (const bad of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
    ]) {
      await expect(
        resolvePublic(url("https://rebind.example/"), resolver({ "rebind.example": [bad] })),
        bad,
      ).rejects.toBeInstanceOf(WebError);
    }
  });

  it("refuses when any one of several answers is private", async () => {
    await expect(
      resolvePublic(
        url("https://mixed.example/"),
        resolver({ "mixed.example": ["8.8.8.8", "127.0.0.1"] }),
      ),
    ).rejects.toThrow(WebError);
  });

  it("fails cleanly when DNS fails or has no answer", async () => {
    await expect(
      resolvePublic(url("https://x.example/"), async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(WebError);
    await expect(resolvePublic(url("https://x.example/"), async () => [])).rejects.toThrow(
      WebError,
    );
  });
});

describe("guardedGet", () => {
  const page =
    (body = "<p>hello</p>") =>
    () =>
      html(body);

  it("fetches a page, pinned to the address that was checked", async () => {
    const transport = fakeTransport({ "https://example.com/": page() });
    const out = await guardedGet("https://example.com/", config, signal(), {
      resolve: resolver({ "example.com": ["93.184.216.34"] }),
      transport,
    });
    expect(new TextDecoder().decode(out.bytes)).toBe("<p>hello</p>");
    expect(out.truncated).toBe(false);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.address).toEqual({ address: "93.184.216.34", family: 4 });
    expect(transport.calls[0]?.headers["user-agent"]).toBe(
      "Mozilla/5.0 (compatible; Miyoria/0.1; +https://github.com/owenliu0924/Miyoria)",
    );
    expect(Object.keys(transport.calls[0]?.headers ?? {})).not.toContain("cookie");
  });

  it("never connects when the name resolves to 127.0.0.1", async () => {
    const transport = fakeTransport({ "https://rebind.example/": page() });
    await expect(
      guardedGet("https://rebind.example/", config, signal(), {
        resolve: resolver({ "rebind.example": ["127.0.0.1"] }),
        transport,
      }),
    ).rejects.toThrow(WebError);
    expect(transport.calls).toHaveLength(0);
  });

  it("never connects to a private literal", async () => {
    const transport = fakeTransport({});
    await expect(
      guardedGet("http://169.254.169.254/", config, signal(), { resolve: resolver(), transport }),
    ).rejects.toThrow(WebError);
    expect(transport.calls).toHaveLength(0);
  });

  it("follows redirects, re-checking every hop", async () => {
    const transport = fakeTransport({
      "https://a.example/": () => response(302, "", { location: "https://b.example/next" }),
      "https://b.example/next": () => response(301, "", { location: "/final" }),
      "https://b.example/final": page("<p>done</p>"),
    });
    const out = await guardedGet("https://a.example/", config, signal(), {
      resolve: resolver(),
      transport,
    });
    expect(out.url.href).toBe("https://b.example/final");
    expect(transport.calls.map((c) => c.url.href)).toEqual([
      "https://a.example/",
      "https://b.example/next",
      "https://b.example/final",
    ]);
  });

  it("refuses a redirect to a private address, a private literal or localhost", async () => {
    for (const location of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:80/",
      "http://[::1]/",
      "http://intranet/",
      "file:///etc/passwd",
      "https://inner.example/",
    ]) {
      const transport = fakeTransport({
        "https://a.example/": () => response(302, "", { location }),
        "https://inner.example/": page(),
      });
      await expect(
        guardedGet("https://a.example/", config, signal(), {
          resolve: resolver({ "inner.example": ["192.168.1.10"] }),
          transport,
        }),
        location,
      ).rejects.toThrow(WebError);
      expect(transport.calls.map((c) => c.url.href)).toEqual(["https://a.example/"]);
    }
  });

  it("stops after three redirects", async () => {
    const hop = (n: number) => () => response(302, "", { location: `https://r.example/${n + 1}` });
    const transport = fakeTransport({
      "https://r.example/0": hop(0),
      "https://r.example/1": hop(1),
      "https://r.example/2": hop(2),
      "https://r.example/3": hop(3),
      "https://r.example/4": page(),
    });
    await expect(
      guardedGet("https://r.example/0", config, signal(), { resolve: resolver(), transport }),
    ).rejects.toThrow(/轉址/);
    expect(transport.calls).toHaveLength(4); // the page and three hops
    // Exactly three hops are fine.
    const ok = fakeTransport({
      "https://r.example/0": hop(0),
      "https://r.example/1": hop(1),
      "https://r.example/2": hop(2),
      "https://r.example/3": page("<p>ok</p>"),
    });
    const out = await guardedGet("https://r.example/0", config, signal(), {
      resolve: resolver(),
      transport: ok,
    });
    expect(out.url.pathname).toBe("/3");
  });

  it("refuses a redirect without a location", async () => {
    const transport = fakeTransport({ "https://a.example/": () => response(302, "") });
    await expect(
      guardedGet("https://a.example/", config, signal(), { resolve: resolver(), transport }),
    ).rejects.toThrow(WebError);
  });

  it("reads only text/html and text/plain", async () => {
    for (const type of [
      "application/pdf",
      "image/png",
      "application/octet-stream",
      "video/mp4",
      "application/json",
    ]) {
      const transport = fakeTransport({
        "https://f.example/": () => response(200, "x", { "content-type": type }),
      });
      await expect(
        guardedGet("https://f.example/", config, signal(), { resolve: resolver(), transport }),
        type,
      ).rejects.toThrow(WebError);
    }
    for (const type of ["text/plain", "text/html; charset=utf-8", "application/xhtml+xml"]) {
      const transport = fakeTransport({
        "https://f.example/": () => response(200, "x", { "content-type": type }),
      });
      await expect(
        guardedGet("https://f.example/", config, signal(), { resolve: resolver(), transport }),
        type,
      ).resolves.toMatchObject({ truncated: false });
    }
  });

  it("answers an error status as a failure", async () => {
    const transport = fakeTransport({ "https://f.example/": () => response(404, "nope") });
    await expect(
      guardedGet("https://f.example/", config, signal(), { resolve: resolver(), transport }),
    ).rejects.toThrow(/404/);
  });

  it("stops reading at the size limit and drops the connection", async () => {
    const small = WebConfigSchema.parse({ max_download_bytes: 10_000 });
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(4_000).fill(97));
    const res = response(200, chunks, { "content-type": "text/html" });
    const transport = fakeTransport({ "https://big.example/": () => res });
    const out = await guardedGet("https://big.example/", small, signal(), {
      resolve: resolver(),
      transport,
    });
    expect(out.bytes.length).toBe(10_000);
    expect(out.truncated).toBe(true);
    expect(res.destroyed).toBe(true);
  });

  it("gives up after the timeout", async () => {
    const quick = WebConfigSchema.parse({ timeout_ms: 1000 });
    const transport: typeof fakeTransport extends (...a: never[]) => infer T ? T : never =
      Object.assign(
        (request: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
        { calls: [] },
      ) as never;
    const started = Date.now();
    await expect(
      guardedGet("https://slow.example/", quick, signal(), { resolve: resolver(), transport }),
    ).rejects.toThrow(/太久/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const transport = Object.assign(
      (request: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { calls: [] },
    ) as never;
    const run = guardedGet("https://slow.example/", config, controller.signal, {
      resolve: resolver(),
      transport,
    });
    controller.abort();
    await expect(run).rejects.toThrow(WebError);
  });
});
