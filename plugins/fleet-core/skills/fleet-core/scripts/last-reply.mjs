#!/usr/bin/env node
// Prints a Claude Code worker's last reply for the fleet skills, read from Claude Code's own
// record of the session: <config dir>/projects/<worktree>/<session>.jsonl. A worker's screen is no
// record. Claude Code in full-screen mode keeps no scrollback, so a reply taller than the screen
// never shows whole, and a worker that sits idle compacts its conversation, which clears the reply
// from the screen. The session file keeps it.
// Prints JSON on stdout. Errors go to stderr, with exit status 1.
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  "usage: last-reply.mjs --worktree <path> --config-dir <the worker profile's config dir> [--max-chars <n>]";

class CliError extends Error {}

// Claude Code names a session's folder after the folder it runs in, with every character but a
// letter or a digit turned into "-". A name longer than 200 characters is cut there, and a hash of
// the whole path follows it.
const PROJECT_DIR_MAX_LENGTH = 200;

function projectDirName(folder) {
  const normal = folder.normalize("NFC").replace(/(?<=.)[\\/]+$/, "");
  const name = normal.replaceAll(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= PROJECT_DIR_MAX_LENGTH) return name;
  let hash = 0;
  for (let i = 0; i < normal.length; i++) hash = ((hash << 5) - hash + normal.charCodeAt(i)) | 0;
  return `${name.slice(0, PROJECT_DIR_MAX_LENGTH)}-${Math.abs(hash).toString(36)}`;
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    // Claude Code moves some session files away; one may go between the listing and this.
    return undefined;
  }
}

// When `git worktree add` made the worktree: it writes the worktree's .git file then, and never
// again. A fleet reuses a path such as ~/.clausona/worktrees/<repo>/<task> for a later task of the
// same name, and Claude Code keeps the sessions of the earlier one for weeks.
function madeAt(worktree) {
  try {
    const gitFile = statSync(path.join(worktree, ".git"));
    return gitFile.isFile() ? gitFile.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session file Claude Code wrote last for `worktree` (a hand-over starts a new one), or null
 * when every session there is older than the worktree.
 */
function newestSession(configDir, worktree) {
  const given = path.resolve(worktree);
  let real = given;
  try {
    real = realpathSync(given);
  } catch {
    // a worktree that is gone can still have its sessions
  }
  const since = madeAt(real);
  for (const folder of new Set([real, given])) {
    const dir = path.join(configDir, "projects", projectDirName(folder));
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const sessions = names
      .map((name) => ({ file: path.join(dir, name), mtime: mtimeOf(path.join(dir, name)) }))
      .filter((s) => s.mtime !== undefined)
      .sort((a, b) => b.mtime - a.mtime);
    if (sessions.length === 0) continue;
    return since === undefined || sessions[0].mtime >= since ? sessions[0].file : null;
  }
  throw new CliError(
    `no Claude Code session for ${given} under ${path.join(configDir, "projects")}. ` +
      "Is it a Claude Code worker, and is this its profile's config dir?",
  );
}

function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function hasBlock(content, type) {
  return Array.isArray(content) && content.some((block) => block?.type === type);
}

// What someone sent the worker. Tool results, a compaction's summary, notes Claude Code adds for
// itself, and the record of a slash command or a ! shell command are not.
function isPrompt(entry) {
  if (entry.type === "attachment") {
    const a = entry.attachment;
    return (
      a?.type === "queued_command" &&
      a.commandMode === "prompt" &&
      typeof a.prompt === "string" &&
      a.prompt.trim() !== ""
    );
  }
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false;
  const text = textOf(entry.message?.content);
  return text !== "" && !/^<(?:command-|local-command-|bash-)/.test(text);
}

/**
 * The last reply in `lines` (oldest first); or a prompt that came after it; or a tool call after
 * it, when the worker's turn is still going. Undefined when the lines hold none of these, and an
 * earlier part of the file must be read too.
 */
function judge(lines) {
  let reply;
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    if (entry.type === "assistant") {
      const text = textOf(entry.message?.content);
      const id = entry.message?.id;
      if (!reply) {
        if (text) reply = { text, at: entry.timestamp, id };
        else if (hasBlock(entry.message?.content, "tool_use")) return { busy: true };
        continue;
      }
      // Claude Code writes each block of one message as an entry of its own.
      if (id !== undefined && id === reply.id) {
        if (text) reply.text = `${text}\n${reply.text}`;
        continue;
      }
      return { reply };
    }
    if (reply) {
      if (entry.type === "user") return { reply };
      continue;
    }
    if (entry.type === "user" && hasBlock(entry.message?.content, "tool_result")) return { busy: true };
    if (isPrompt(entry)) return { prompt: true };
  }
  return reply ? { reply, partial: true } : undefined;
}

// A session file can run to many megabytes, and the answer sits at its end: read the end, and
// more of it only when that does not settle it.
function lastReply(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    for (let window = 1 << 20; ; window *= 4) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      // A window that starts mid-file starts mid-line.
      if (start > 0) lines.shift();
      const found = judge(lines);
      if (start === 0) return found;
      if (found && !found.partial) return found;
    }
  } finally {
    closeSync(fd);
  }
}

// A worker's report ends in its DONE or BLOCKED line, so a reply too long to keep whole keeps its end.
function keepEnd(text, max) {
  if (text.length <= max) return text;
  let tail = text.slice(-max);
  // Never start on the second half of a surrogate pair.
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return `[${text.length - tail.length} characters cut]\n${tail}`;
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { worktree: { type: "string" }, "config-dir": { type: "string" }, "max-chars": { type: "string" } },
      strict: true,
    }));
  } catch (err) {
    throw new CliError(`${err.message}\n${USAGE}`);
  }
  if (!values.worktree || !values["config-dir"]) throw new CliError(USAGE);
  const maxText = values["max-chars"] ?? "8000";
  if (!/^\d+$/.test(maxText) || Number(maxText) === 0) throw new CliError("--max-chars must be a positive integer");
  const session = newestSession(values["config-dir"], values.worktree);
  if (session === null) {
    return { session: null, reply: null, why: "no session since the worktree was made: only an earlier task's" };
  }
  const found = lastReply(session);
  if (!found?.reply) {
    const why = found?.prompt
      ? "nothing since its last prompt"
      : found?.busy
        ? "its turn is still going"
        : "no reply yet";
    return { session, reply: null, why };
  }
  return { session, at: found.reply.at ?? null, reply: keepEnd(found.reply.text, Number(maxText)) };
}

try {
  process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
} catch (err) {
  const text = err instanceof CliError ? err.message : String(err?.stack ?? err);
  process.stderr.write(`last-reply: ${text}\n`);
  process.exitCode = 1;
}
