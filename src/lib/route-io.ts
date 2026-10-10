import { createInterface } from "node:readline";

/**
 * The terminal, as the route commands see it. Injected in tests. The route CLI asks nothing but
 * `route edit`'s "edit again?" and the one Y/n of `clausona run --route <unknown>`.
 */
export type RouteIo = {
  interactive: boolean;
  /** One answer, trimmed; null when the input closed (Ctrl-D) or on Ctrl-C. */
  ask: (question: string) => Promise<string | null>;
  say: (text: string) => void;
  /** A Y/n, read as `askYesNo` reads one: Enter, y or yes is yes; anything else, Ctrl-D or Ctrl-C is no. */
  confirm: (question: string) => Promise<boolean>;
};

/**
 * Prompts on `stream` and reads `input` (stdin; a test passes its own). `clausona run` passes stderr,
 * so a routed run whose stdout is piped (`-p … > out.txt`) still asks on the terminal and keeps the
 * file clean.
 */
export function terminalIo(
  stream: NodeJS.WriteStream = process.stderr,
  input: NodeJS.ReadStream = process.stdin,
): RouteIo {
  const ask = (question: string) =>
    new Promise<string | null>((resolve) => {
      // An input that has already ended never emits `close` again: the question would wait forever.
      if (input.readableEnded) {
        resolve(null);
        return;
      }
      const rl = createInterface({ input, output: stream });
      let done = false;
      const finish = (answer: string | null) => {
        if (done) return;
        done = true;
        resolve(answer === null ? null : answer.trim());
        // Closing emits `close`, which the flag above has already made a no-op.
        rl.close();
      };
      // Ctrl-D and Ctrl-C leave the cursor after the question, so whatever is said next starts a line.
      const cancel = () => {
        if (!done) stream.write("\n");
        finish(null);
      };
      rl.on("close", cancel);
      rl.on("SIGINT", cancel);
      rl.question(question, (answer) => finish(answer));
    });
  return {
    interactive: input.isTTY === true && stream.isTTY === true,
    ask,
    // Built on `ask` rather than on commands.ts's askYesNo, which reads the same answers: this way
    // an input that has ended is a no, not a wait, and a Ctrl-D still ends the question's line.
    confirm: async (question) => {
      const answer = await ask(question);
      return answer !== null && ["", "y", "yes"].includes(answer.toLowerCase());
    },
    say: (text) => {
      stream.write(`${text}\n`);
    },
  };
}
