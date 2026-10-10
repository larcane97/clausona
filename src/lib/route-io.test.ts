import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { terminalIo } from "./route-io.js";

describe("terminalIo", () => {
  const streams = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += String(chunk);
    });
    const io = terminalIo(output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    return { input, io, written: () => written };
  };

  it("is not interactive without a terminal", () => {
    expect(streams().io.interactive).toBe(false);
  });

  it("asks on the stream and resolves to the answer, trimmed", async () => {
    const { input, io, written } = streams();
    const answer = io.ask("Create? ");
    input.write("  e  \n");
    expect(await answer).toBe("e");
    io.say("done");
    expect(written()).toBe("Create? done\n");
  });

  it("resolves null once the input closes, and for every question after it", async () => {
    const { input, io } = streams();
    const first = io.ask("Create? ");
    input.end();
    expect(await first).toBeNull();
    expect(await io.ask("Again? ")).toBeNull();
  });

  it("confirms on Enter, y or yes, in any case", async () => {
    for (const reply of ["", "y", "YES"]) {
      const { input, io } = streams();
      const answer = io.confirm("Create it and run? (Y/n) ");
      input.write(`${reply}\n`);
      expect(await answer).toBe(true);
    }
  });

  it("declines on n, and once the input has ended", async () => {
    const { input, io, written } = streams();
    const answer = io.confirm("Create it and run? (Y/n) ");
    input.write("n\n");
    expect(await answer).toBe(false);
    expect(written()).toBe("Create it and run? (Y/n) ");

    const ended = streams();
    const first = ended.io.confirm("Create it and run? (Y/n) ");
    ended.input.end();
    expect(await first).toBe(false);
    // An input that has already ended does not leave the question waiting.
    expect(await ended.io.confirm("Again? (Y/n) ")).toBe(false);
  });
});
