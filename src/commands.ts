import path from "node:path";
import { createInterface } from "node:readline";
import { trackUsage } from "./core/track-usage.js";
import { accent, bold, box, dim, helpSection, helpUsage, secondary, success } from "./lib/cli-style.js";
import { renderDoctor, renderList, renderUsageSummary } from "./lib/format.js";
import { parseProfileRef, profileId } from "./lib/profile-ref.js";
import {
  addProfile,
  discoverAccounts,
  doctorProfiles,
  getUsageSummary,
  initializeRegistry,
  listProfiles,
  loadRegistry,
  loginProfile,
  removeProfile,
  repairProfile,
  setActiveProfileByName,
  shellInit,
  syncPluginsJson,
  uninstallClausona,
  updateProfileConfig,
} from "./lib/service.js";
import { ALL_TOOLS } from "./tools/registry.js";
import type { ToolName } from "./types.js";

function jsonFlag(args: string[]) {
  return args.includes("--json");
}

function helpFlag(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

const commandFlags: Record<string, { flags: string[]; prefixes?: string[] }> = {
  init: { flags: ["--auto", "--merge-sessions"] },
  add: { flags: ["--from", "--merge-sessions"] },
  use: { flags: [] },
  list: { flags: ["--json"] },
  usage: { flags: ["--json"], prefixes: ["--period="] },
  current: { flags: ["--json"] },
  doctor: { flags: ["--json"] },
  config: { flags: ["--merge-sessions", "--separate-sessions"] },
  repair: { flags: [] },
  login: { flags: [] },
  remove: { flags: [] },
  run: { flags: [] },
  "shell-init": { flags: [] },
  uninstall: { flags: [] },
  version: { flags: [] },
};

function validateFlags(command: string, args: string[]) {
  const spec = commandFlags[command];
  if (!spec) return;
  const known = ["--help", "-h", ...spec.flags];
  const prefixes = spec.prefixes ?? [];
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    if (known.includes(arg)) continue;
    if (prefixes.some((p) => arg.startsWith(p))) continue;
    throw new Error(`Unknown option: ${arg}\nRun \`clausona ${command} --help\` for usage.`);
  }
}

// ─── Subcommand Help ────────────────────────────────────────────────

function subcommandHelpText(command: string): string | undefined {
  switch (command) {
    case "init":
      return [
        "",
        `  ${accent("clausona init")} ${dim("— Discover accounts interactively")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona init [--auto] [--merge-sessions]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--auto".padEnd(18))}${dim("Run non-interactively (skip TUI)")}`,
        `    ${accent("--merge-sessions".padEnd(18))}${dim("Share session history across profiles (default: separated)")}`,
        "",
      ].join("\n");

    case "add":
      return [
        "",
        `  ${accent("clausona add")} ${dim("— Add a new profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona add <profile> [--from <path>] [--merge-sessions]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(18))}${dim("Profile to create (e.g. work or claude:work)")}`,
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--from".padEnd(18))}${dim("Import configuration from an existing path")}`,
        `    ${accent("--merge-sessions".padEnd(18))}${dim("Share session history across profiles (default: separated)")}`,
        "",
      ].join("\n");

    case "use":
      return [
        "",
        `  ${accent("clausona use")} ${dim("— Switch active profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona use [profile]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to switch to (opens TUI picker if omitted)")}`,
        "",
      ].join("\n");

    case "list":
      return [
        "",
        `  ${accent("clausona list")} ${dim("— Show profiles with usage")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona list [--json]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
      ].join("\n");

    case "usage":
      return [
        "",
        `  ${accent("clausona usage")} ${dim("— Show usage summary")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona usage [profile] [--period=<period>] [--json]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile (shows all profiles if omitted)")}`,
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--period".padEnd(12))}${dim("<today|week|month|all>  Time period (default: today)")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
      ].join("\n");

    case "current":
      return [
        "",
        `  ${accent("clausona current")} ${dim("— Show active profile details")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona current [--json]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
      ].join("\n");

    case "doctor":
      return [
        "",
        `  ${accent("clausona doctor")} ${dim("— Check profile health")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona doctor [--json]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
      ].join("\n");

    case "config":
      return [
        "",
        `  ${accent("clausona config")} ${dim("— Configure profile settings")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona config <profile> --merge-sessions | --separate-sessions"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to configure")}`,
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--merge-sessions".padEnd(22))}${dim("Share sessions with primary profile")}`,
        `    ${accent("--separate-sessions".padEnd(22))}${dim("Keep sessions isolated (default)")}`,
        "",
      ].join("\n");

    case "repair":
      return [
        "",
        `  ${accent("clausona repair")} ${dim("— Repair shared links for a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona repair <profile>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to repair")}`,
        "",
      ].join("\n");

    case "login":
      return [
        "",
        `  ${accent("clausona login")} ${dim("— Re-authenticate a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona login <profile>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to re-authenticate")}`,
        "",
      ].join("\n");

    case "remove":
      return [
        "",
        `  ${accent("clausona remove")} ${dim("— Remove a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona remove <profile>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to remove")}`,
        "",
      ].join("\n");

    case "run":
      return [
        "",
        `  ${accent("clausona run")} ${dim("— Run the CLI with a specific profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona run <profile> [-- args...]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(14))}${dim("Profile to use (overrides shell-init env)")}`,
        `    ${accent("args".padEnd(14))}${dim("Arguments passed through to the tool's CLI")}`,
        "",
        `  ${bold("EXAMPLES")}`,
        `    ${dim("clausona run claude:work")}`,
        `    ${dim("clausona run claude:personal -p /path/to/project")}`,
        `    ${dim("clausona run codex:personal -- 'review this'")}`,
        "",
      ].join("\n");

    case "shell-init":
      return [
        "",
        `  ${accent("clausona shell-init")} ${dim("— Print shell integration")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona shell-init"),
        "",
      ].join("\n");

    case "uninstall":
      return [
        "",
        `  ${accent("clausona uninstall")} ${dim("— Uninstall clausona completely")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona uninstall"),
        "",
        `  ${bold("DESCRIPTION")}`,
        `    ${dim("Removes all profiles, shell integration, data, and the clausona binary.")}`,
        `    ${dim("Imported profiles are restored from backup. Primary profile is left intact.")}`,
        "",
      ].join("\n");

    case "version":
      return [
        "",
        `  ${accent("clausona version")} ${dim("— Show version")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona version"),
        "",
      ].join("\n");

    default:
      return undefined;
  }
}

// ─── Main Help ──────────────────────────────────────────────────────

function usageText() {
  return [
    "",
    `  ${bold("clausona")} ${dim("— Claude Code and Codex CLI profile manager")}`,
    "",
    `  ${bold("USAGE")}`,
    `    clausona ${accent("[command]")}`,
    "",
    helpSection("COMMANDS", [
      ["run <profile>", "Run the CLI with a specific profile"],
      ["init", "Discover accounts interactively"],
      ["add <profile>", "Add a new profile"],
      ["use [profile]", "Switch active profile"],
      ["list", "Show profiles with usage"],
      ["usage [profile]", "Show usage summary"],
      ["current", "Show active profile details"],
      ["config <profile>", "Configure profile settings"],
      ["doctor", "Check profile health"],
      ["repair <profile>", "Repair shared links"],
      ["login <profile>", "Re-authenticate a profile"],
      ["remove <profile>", "Remove a profile"],
      ["uninstall", "Uninstall clausona completely"],
      ["shell-init", "Print shell integration"],
      ["version", "Show version"],
    ]),
    "",
    dim("  Note: <profile> is a bare name (e.g. work) or tool:name (e.g. claude:work, codex:personal)"),
    "",
  ].join("\n");
}

// ─── Command Runner ─────────────────────────────────────────────────

export async function runCommand(command: string, args: string[]) {
  if (command !== "help" && command !== "-h" && command !== "--help" && helpFlag(args)) {
    const helpText = subcommandHelpText(command);
    if (helpText) return helpText;
  }

  validateFlags(command, args);

  switch (command) {
    case "help":
    case "-h":
    case "--help":
      return usageText();

    case "version":
    case "-v":
    case "--version":
      return `  ${accent("clausona")} ${dim("v0.1.0-beta")}`;

    case "shell-init":
      return shellInit();

    case "list": {
      const items = await listProfiles();
      return jsonFlag(args) ? JSON.stringify(items, null, 2) : renderList(items);
    }

    case "current": {
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");

      if (jsonFlag(args)) {
        const out: Record<string, unknown> = {};
        for (const tool of ALL_TOOLS) {
          const activeId = registry.activeProfiles[tool];
          if (!activeId) continue;
          const profile = registry.profiles[activeId];
          if (!profile) continue;
          out[tool] = { id: activeId, ...profile };
        }
        if (Object.keys(out).length === 0) {
          throw new Error("No active profiles. Run `clausona init` to set up profiles.");
        }
        return JSON.stringify(out, null, 2);
      }

      const blocks: string[] = [];
      for (const tool of ALL_TOOLS) {
        const activeId = registry.activeProfiles[tool];
        if (!activeId) continue;
        const profile = registry.profiles[activeId];
        if (!profile) continue;
        const configPath = profile.configDir.replace(path.join(process.env.HOME ?? "", "/"), "~/");
        blocks.push(
          box(activeId, [
            `${secondary("Account".padEnd(12))}${profile.email}`,
            ...(profile.orgName ? [`${secondary("Org".padEnd(12))}${profile.orgName}`] : []),
            `${secondary("Config".padEnd(12))}${dim(configPath)}`,
            ...(!profile.isPrimary
              ? [`${secondary("Sessions".padEnd(12))}${profile.mergeSessions ? "merged" : "separated"}`]
              : []),
          ]),
        );
      }

      if (blocks.length === 0) {
        throw new Error("No active profiles. Run `clausona init` to set up profiles.");
      }
      return blocks.join("\n");
    }

    case "use": {
      const [input] = args;
      if (!input) return "__OPEN_TUI__:use";
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const profile = await setActiveProfileByName(ref.id);
      return success(`Switched to ${bold(ref.id)} ${dim(`(${profile.email})`)}`);
    }

    case "usage": {
      const [input] = args.filter((arg) => !arg.startsWith("--"));
      const periodArg = args.find((arg) => arg.startsWith("--period="));
      const periodValue = periodArg?.split("=")[1];
      const period: "today" | "week" | "month" | "all" = (() => {
        if (!periodValue) return "today";
        if (periodValue === "today" || periodValue === "week" || periodValue === "month" || periodValue === "all") {
          return periodValue;
        }
        throw new Error(`Invalid --period value '${periodValue}'. Use: today | week | month | all.`);
      })();

      let id: string | null = null;
      if (input) {
        const registry = await loadRegistry();
        if (!registry) throw new Error("clausona is not initialized.");
        const ref = parseProfileRef(input, registry);
        if (ref.tool === "codex") {
          throw new Error("Usage tracking not supported for codex (yet).");
        }
        id = ref.id;
      }

      const summary = await getUsageSummary(id, period);
      if (!summary) return success(dim("No usage data found."));
      if (jsonFlag(args)) return JSON.stringify(summary, null, 2);
      return renderUsageSummary(summary, id ?? undefined, period);
    }

    case "doctor": {
      const results = await doctorProfiles();
      return jsonFlag(args) ? JSON.stringify(results, null, 2) : renderDoctor(results);
    }

    case "repair": {
      const [input] = args.filter((arg) => !arg.startsWith("--"));
      if (!input) throw new Error("Usage: clausona repair <profile>");
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const result = await repairProfile(ref.id);
      return success(`Repaired ${bold(String(result.repaired))} shared item(s) for ${bold(ref.id)}`);
    }

    case "login": {
      const [input] = args;
      if (!input) throw new Error("Usage: clausona login <profile>");
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const profile = await loginProfile(ref.id);
      return success(`Token refreshed for ${bold(profile.email)}`);
    }

    case "config": {
      const mergeSessions = args.includes("--merge-sessions");
      const separateSessions = args.includes("--separate-sessions");
      if (mergeSessions === separateSessions) {
        throw new Error("Usage: clausona config <profile> --merge-sessions | --separate-sessions");
      }
      const [input] = args.filter((a) => !a.startsWith("--"));
      if (!input) {
        throw new Error("Usage: clausona config <profile> --merge-sessions | --separate-sessions");
      }
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const result = await updateProfileConfig(ref.id, { mergeSessions });
      if (!result.changed) return dim(`${ref.id} is already ${mergeSessions ? "merged" : "separated"}`);
      return success(`${bold(ref.id)} sessions set to ${result.mergeSessions ? "merged" : "separated"}`);
    }

    case "remove": {
      const [input] = args.filter((arg) => !arg.startsWith("--"));
      if (!input) throw new Error("Usage: clausona remove <profile>");
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      await removeProfile(ref.id);
      return success(`Removed ${bold(ref.id)}`);
    }

    case "add": {
      const fromIndex = args.indexOf("--from");
      const fromPath = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
      const fromValueIndex = fromIndex >= 0 ? fromIndex + 1 : -1;
      const mergeSessions = args.includes("--merge-sessions");
      const [input] = args.filter((arg, i) => !arg.startsWith("--") && i !== fromValueIndex);
      if (!input) throw new Error("Usage: clausona add <profile> [--from <path>] [--merge-sessions]");

      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");

      let tool: ToolName;
      let name: string;
      if (input.includes(":")) {
        const [maybeTool, ...rest] = input.split(":");
        if (!(ALL_TOOLS as readonly string[]).includes(maybeTool)) {
          throw new Error(`Unknown tool '${maybeTool}'. Use one of: ${ALL_TOOLS.join(", ")}.`);
        }
        tool = maybeTool as ToolName;
        name = rest.join(":");
      } else {
        const configured = ALL_TOOLS.filter((t) => registry.primarySources[t]);
        if (configured.length === 0) {
          throw new Error("No tools configured. Run `clausona init` first.");
        }
        if (configured.length > 1) {
          throw new Error(
            `Both tools are configured. Specify '${configured.map((t) => `${t}:${input}`).join("' or '")}'.`,
          );
        }
        tool = configured[0];
        name = input;
      }

      if (!name) {
        throw new Error("Profile name cannot be empty.");
      }
      if (name.includes(":")) {
        throw new Error(`Profile name '${name}' cannot contain ':'.`);
      }

      const added = await addProfile({ tool, name, fromPath, mergeSessions: mergeSessions || undefined });
      return success(`Added ${bold(profileId(tool, added.name))} ${dim(`(${added.email})`)}`);
    }

    case "run": {
      throw new Error("Usage: clausona run <profile> [claude-args...]");
    }

    case "_sync-plugins": {
      const registry = await loadRegistry();
      if (!registry) return "";
      const claudePrimary = registry.primarySources.claude ?? path.join(process.env.HOME ?? "", ".claude");
      const configDir = process.env.CLAUDE_CONFIG_DIR ?? claudePrimary;
      await syncPluginsJson(configDir, claudePrimary).catch(() => {});
      return "";
    }

    case "_track-usage": {
      await trackUsage();
      return "";
    }

    case "uninstall": {
      process.stdout.write(
        `${[
          "",
          `  ${bold("This will completely uninstall clausona:")}`,
          `    ${dim("• Strip symlinks and restore backups for all non-primary profiles")}`,
          `    ${dim("• Profile directories at ~/.claude-<name> are preserved (data intact)")}`,
          `    ${dim("• Remove shell integration from rc files")}`,
          `    ${dim("• Delete ~/.clausona/ directory (registry, usage, backups)")}`,
          `    ${dim("• Delete app files and launcher binary")}`,
          "",
        ].join("\n")}\n`,
      );

      const confirmed = await new Promise<boolean>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`  Proceed? ${accent("(y/N)")} `, (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase() === "y");
        });
      });

      if (!confirmed) {
        return dim("  Cancelled.");
      }

      const result = await uninstallClausona();
      if (result.removed.length === 0) {
        return success(dim("Nothing to uninstall."));
      }
      return [
        success("clausona has been uninstalled."),
        "",
        ...result.removed.map((item) => `  ${dim("•")} ${dim(item)}`),
        "",
        dim("  Open a new terminal to clear the shell integration."),
      ].join("\n");
    }

    case "init": {
      if (!args.includes("--auto")) {
        return "__OPEN_TUI__:init";
      }

      const accounts = await discoverAccounts();
      if (accounts.length === 0) {
        throw new Error("No Claude Code accounts found. Run `claude login` first.");
      }
      const mergeSessions = args.includes("--merge-sessions") || undefined;
      const profileNames = Object.fromEntries(
        accounts.map((account) => [
          account.configDir,
          account.isPrimary ? "default" : path.basename(account.configDir).replace(/^\.claude-/, ""),
        ]),
      );
      const defaultProfile = Object.values(profileNames)[0] ?? "default";
      await initializeRegistry({ accounts, profileNames, defaultProfile, mergeSessions });
      return success(`Initialized ${bold(String(accounts.length))} profile(s)`);
    }

    default:
      return usageText();
  }
}

export async function bootstrapInitFromCurrentState() {
  const accounts = await discoverAccounts();
  const existing = await loadRegistry();
  const profileNames = Object.fromEntries(
    accounts.map((account) => [
      account.configDir,
      Object.entries(existing?.profiles ?? {}).find(([, profile]) => profile.configDir === account.configDir)?.[0] ??
        (account.isPrimary ? "default" : path.basename(account.configDir).replace(/^\.claude-/, "")),
    ]),
  );

  return {
    accounts,
    profileNames,
    defaultProfile: existing?.activeProfiles?.claude ?? Object.values(profileNames)[0] ?? "default",
  };
}
