import { describe, expect, it } from "vitest";

import { ExitError, withJsonErrors } from "./json-errors.js";

/** What a rejected run threw, for a look at its code, kind, message and stdout. */
async function failure(promise: Promise<string>): Promise<ExitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ExitError)) throw new Error(`expected an ExitError, got ${String(error)}`);
  return error;
}

describe("withJsonErrors", () => {
  it("is the run itself without --json", async () => {
    const thrown = new ExitError("bad", 2);
    await expect(withJsonErrors(["ls"], async () => "ok")).resolves.toBe("ok");
    await expect(withJsonErrors(["ls"], () => Promise.reject(thrown))).rejects.toBe(thrown);
  });

  it("makes any other error one JSON object, keeping its code", async () => {
    const usage = await failure(withJsonErrors(["--json"], () => Promise.reject(new ExitError("bad", 2))));
    expect(usage).toMatchObject({ code: 2, kind: undefined });
    expect(JSON.parse(usage.stdout ?? "")).toEqual({ version: 1, error: "usage", message: "bad" });
    const found = await failure(withJsonErrors(["--json"], () => Promise.reject(new ExitError("none", 1))));
    expect(JSON.parse(found.stdout ?? "")).toEqual({ version: 1, error: "not-found", message: "none" });
    const extra = new ExitError("stop", 1, undefined, "locked", { done: 1 });
    const locked = await failure(withJsonErrors(["--json"], () => Promise.reject(extra)));
    expect(JSON.parse(locked.stdout ?? "")).toEqual({ version: 1, error: "locked", message: "stop", done: 1 });
    const failed = await failure(withJsonErrors(["--json"], () => Promise.reject(new Error("boom"))));
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout ?? "")).toEqual({ version: 1, error: "failed", message: "boom" });
    const given = new ExitError("2 match", 2, '{"version":1}', "ambiguous");
    expect(await failure(withJsonErrors(["--json"], () => Promise.reject(given)))).toBe(given);
  });
});
