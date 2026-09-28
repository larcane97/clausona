import { describe, expect, it } from "vitest";

import {
  checkLatestTag,
  compareVersions,
  type FetchLike,
  findUpdate,
  isNewer,
  reinstallCommand,
  tagFromLocation,
} from "./update.js";

describe("compareVersions", () => {
  it.each([
    ["0.2.5-beta", "0.3.0-beta", -1],
    ["0.3.0-beta", "0.3.0", -1],
    ["0.3.0", "0.3.0-beta", 1],
    ["0.3.0-beta.1", "0.3.0-beta.2", -1],
    ["0.3.0-beta.2", "0.3.0-beta.10", -1],
    ["0.3.0-beta", "0.3.0-beta.1", -1],
    ["0.3.0-1", "0.3.0-beta", -1],
    ["v0.3.1-beta", "0.3.1-beta", 0],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0", "0.99.99", 1],
  ])("%s against %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each(["", "latest", "nightly", "0.3", "0.3.0.1", "v", "0.3.0-"])("does not read %j as a version", (bad) => {
    expect(compareVersions(bad, "0.3.0")).toBeNull();
    expect(isNewer(bad, "0.3.0")).toBe(false);
  });
});

describe("tagFromLocation", () => {
  it.each([
    ["https://github.com/larcane97/clausona/releases/tag/v0.3.1-beta", "v0.3.1-beta"],
    ["/larcane97/clausona/releases/tag/v0.3.1-beta", "v0.3.1-beta"],
    ["https://github.com/larcane97/clausona/releases/tag/v0.3.1-beta/", "v0.3.1-beta"],
    ["https://github.com/larcane97/clausona/releases/tag/v0.3.1%2Bbuild.1", "v0.3.1+build.1"],
  ])("reads %s", (location, tag) => {
    expect(tagFromLocation(location)).toBe(tag);
  });

  it.each([
    null,
    "",
    "https://github.com/larcane97/clausona/releases",
    "https://github.com/login?return_to=%2Flarcane97",
    "https://github.com/larcane97/clausona/releases/tag/%E0%A4%A",
  ])("finds no tag in %j", (location) => {
    expect(tagFromLocation(location)).toBeNull();
  });
});

describe("checkLatestTag", () => {
  it("reads the tag the latest-release redirect points at", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return new Response(null, {
        status: 302,
        headers: { location: "https://github.com/larcane97/clausona/releases/tag/v0.3.1-beta" },
      });
    };

    expect(await checkLatestTag({ fetch })).toBe("v0.3.1-beta");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("https://github.com/larcane97/clausona/releases/latest");
    expect(calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("is null for an answer that is not a redirect", async () => {
    expect(await checkLatestTag({ fetch: async () => new Response("ok", { status: 200 }) })).toBeNull();
  });

  it("is null for a redirect without a location", async () => {
    expect(await checkLatestTag({ fetch: async () => new Response(null, { status: 302 }) })).toBeNull();
  });

  it("is null when the request fails", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await checkLatestTag({ fetch })).toBeNull();
  });

  it("is null when GitHub does not answer in time", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();

    expect(await checkLatestTag({ fetch: hanging, timeoutMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("findUpdate", () => {
  it("offers a later release", async () => {
    const offer = await findUpdate({
      current: "0.3.0-beta",
      target: "/home/u/.local/share/clausona/index.js",
      check: async () => "v0.3.1-beta",
    });

    expect(offer).toEqual({
      current: "0.3.0-beta",
      latest: "0.3.1-beta",
      tag: "v0.3.1-beta",
      target: "/home/u/.local/share/clausona/index.js",
    });
  });

  it.each([
    ["the same release", "0.3.0-beta", "v0.3.0-beta"],
    ["an older release", "0.3.0-beta", "v0.2.5-beta"],
    ["a tag that is not a version", "0.3.0-beta", "nightly"],
    ["a local build ahead of the release", "0.4.0-dev", "v0.3.1-beta"],
    ["no answer", "0.3.0-beta", null],
  ])("offers nothing for %s", async (_case, current, tag) => {
    expect(await findUpdate({ current, target: "/x/index.js", check: async () => tag })).toBeNull();
  });
});

describe("reinstallCommand", () => {
  it("is the README's installer line for the platform", () => {
    expect(reinstallCommand("darwin")).toBe(
      "curl -fsSL https://github.com/larcane97/clausona/releases/latest/download/install.sh | bash",
    );
    expect(reinstallCommand("linux")).toBe(reinstallCommand("darwin"));
    expect(reinstallCommand("win32")).toBe(
      "irm https://github.com/larcane97/clausona/releases/latest/download/install.ps1 | iex",
    );
  });
});
