import path from "node:path";
import { createInterface } from "node:readline";

import {
  addProfile,
  discoverAccounts,
  doctorProfiles,
  getCurrentProfile,
  getUsageSummary,
  initializeRegistry,
  listProfiles,
  loadRegistry,
  loginProfile,
  removeProfile,
  repairProfile,
  setActiveProfileByName,
  updateProfileConfig,
  shellInit,
  uninstallClausona,
} from "./lib/service.js";
import { trackUsage } from "./core/track-usage.js";
import { accent, bold, box, dim, green, helpSection, helpUsage, secondary, styledCost, success } from "./lib/cli-style.js";
import { localTimezoneLabel, renderDoctor, renderList, renderUsageSummary } from "./lib/format.js";

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
        helpUsage("clausona add <name> [--from <path>] [--merge-sessions]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(18))}${dim("Profile name to create")}`,
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
        helpUsage("clausona use [name]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(12))}${dim("Profile to switch to (opens TUI picker if omitted)")}`,
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
        helpUsage("clausona usage [name] [--period=<period>] [--json]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(12))}${dim("Profile name (shows current profile if omitted)")}`,
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
        helpUsage("clausona config <name> --merge-sessions | --separate-sessions"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(12))}${dim("Profile name to configure")}`,
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
        helpUsage("clausona repair <name>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(12))}${dim("Profile name to repair")}`,
        "",
      ].join("\n");

    case "login":
      return [
        "",
        `  ${accent("clausona login")} ${dim("— Re-authenticate a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona login <name>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(12))}${dim("Profile name to re-authenticate")}`,
        "",
      ].join("\n");

    case "remove":
      return [
        "",
        `  ${accent("clausona remove")} ${dim("— Remove a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona remove <name>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("name".padEnd(12))}${dim("Profile name to remove")}`,
        "",
      ].join("\n");

    case "run":
      return [
        "",
        `  ${accent("clausona run")} ${dim("— Run Claude Code with a specific profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona run <profile> [claude-args...]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(14))}${dim("Profile to use (overrides shell-init env)")}`,
        `    ${accent("claude-args".padEnd(14))}${dim("Arguments passed through to claude")}`,
        "",
        `  ${bold("EXAMPLES")}`,
        `    ${dim("clausona run work")}`,
        `    ${dim("clausona run personal -p /path/to/project")}`,
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
    `  ${bold("clausona")} ${dim("— Claude Code profile manager")}`,
    "",
    `  ${bold("USAGE")}`,
    `    clausona ${accent("[command]")}`,
    "",
    helpSection("COMMANDS", [
      ["run <profile>", "Run Claude Code with a specific profile"],
      ["init", "Discover accounts interactively"],
      ["add <name>", "Add a new profile"],
      ["use [name]", "Switch active profile"],
      ["list", "Show profiles with usage"],
      ["usage [name]", "Show usage summary"],
      ["current", "Show active profile details"],
      ["config <name>", "Configure profile settings"],
      ["doctor", "Check profile health"],
      ["repair <name>", "Repair shared links"],
      ["login <name>", "Re-authenticate a profile"],
      ["remove <name>", "Remove a profile"],
      ["uninstall", "Uninstall clausona completely"],
      ["shell-init", "Print shell integration"],
      ["version", "Show version"],
    ]),
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
      return `  ${accent("clausona")} ${dim("v0.1.0")}`;

    case "shell-init":
      return shellInit();

    case "list": {
      const items = await listProfiles();
      return jsonFlag(args) ? JSON.stringify(items, null, 2) : renderList(items);
    }

    case "current": {
      const current = await getCurrentProfile();
      if (!current) {
        throw new Error("No active profile. Run `clausona init` to set up profiles.");
      }
      if (jsonFlag(args)) {
        return JSON.stringify(current, null, 2);
      }

      const configPath = current.configDir.replace(path.join(process.env.HOME ?? "", "/"), "~/");
      const keychainStatus = current.hasKeychain ? green("✔") : dim("✘");

      return box(current.name, [
        `${secondary("Account".padEnd(12))}${current.email}`,
        ...(current.orgName ? [`${secondary("Org".padEnd(12))}${current.orgName}`] : []),
        `${secondary("Config".padEnd(12))}${dim(configPath)}`,
        `${secondary("Keychain".padEnd(12))}${current.keychainService} ${keychainStatus}`,
        ...(!current.isPrimary ? [`${secondary("Sessions".padEnd(12))}${current.mergeSessions ? "merged" : "separated"}`] : []),
        "",
        `${secondary("Today".padEnd(12))}${styledCost(current.usage.today.cost)}  ${dim(localTimezoneLabel())}`,
        `${secondary("Total".padEnd(12))}${styledCost(current.usage.total.cost)}`,
      ]);
    }

    case "use": {
      const [name] = args;
      if (!name) {
        return "__OPEN_TUI__:use";
      }
      const profile = await setActiveProfileByName(name);
      return success(`Switched to ${bold(name)} ${dim(`(${profile.email})`)}`);
    }

    case "usage": {
      const [name] = args.filter((arg) => !arg.startsWith("--"));
      const periodArg = args.find((arg) => arg.startsWith("--period="));
      const period = (periodArg?.split("=")[1] as "today" | "week" | "month" | "all" | undefined) ?? "today";
      const summary = await getUsageSummary(name ?? null, period);
      if (!summary) return success(dim("No usage data found."));
      if (jsonFlag(args)) return JSON.stringify(summary, null, 2);
      return renderUsageSummary(summary, name ?? undefined, period);
    }

    case "doctor": {
      const results = await doctorProfiles();
      return jsonFlag(args) ? JSON.stringify(results, null, 2) : renderDoctor(results);
    }

    case "repair": {
      const [name] = args;
      if (!name) {
        throw new Error("Usage: clausona repair <name>");
      }
      const result = await repairProfile(name);
      return success(`Repaired ${bold(String(result.repaired))} shared item(s) for ${bold(name)}`);
    }

    case "login": {
      const [name] = args;
      if (!name) {
        throw new Error("Usage: clausona login <name>");
      }
      const profile = await loginProfile(name);
      return success(`Token refreshed for ${bold(profile.email)}`);
    }

    case "config": {
      const mergeSessions = args.includes("--merge-sessions");
      const separateSessions = args.includes("--separate-sessions");
      if (mergeSessions === separateSessions) {
        throw new Error("Usage: clausona config <name> --merge-sessions | --separate-sessions");
      }
      const [name] = args.filter((a) => !a.startsWith("--"));
      if (!name) {
        throw new Error("Usage: clausona config <name> --merge-sessions | --separate-sessions");
      }
      const result = await updateProfileConfig(name, { mergeSessions });
      if (!result.changed) return dim(`${name} is already ${mergeSessions ? "merged" : "separated"}`);
      return success(`${bold(name)} sessions set to ${result.mergeSessions ? "merged" : "separated"}`);
    }

    case "remove": {
      const [name] = args.filter((arg) => !arg.startsWith("--"));
      if (!name) {
        throw new Error("Usage: clausona remove <name>");
      }
      await removeProfile(name);
      return success(`Removed ${bold(name)}`);
    }

    case "add": {
      const fromIndex = args.findIndex((arg) => arg === "--from");
      const fromPath = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
      const fromValueIndex = fromIndex >= 0 ? fromIndex + 1 : -1;
      const mergeSessions = args.includes("--merge-sessions");
      const [name] = args.filter((arg, i) => !arg.startsWith("--") && i !== fromValueIndex);
      if (!name) {
        throw new Error("Usage: clausona add <name> [--from <path>] [--merge-sessions]");
      }
      const added = await addProfile({ name, fromPath, mergeSessions: mergeSessions || undefined });
      return success(`Added ${bold(added.name)} ${dim(`(${added.email})`)}`);
    }

    case "run": {
      throw new Error("Usage: clausona run <profile> [claude-args...]");
    }

    case "_track-usage": {
      await trackUsage();
      return "";
    }

    case "uninstall": {
      process.stdout.write(
        [
          "",
          `  ${bold("This will completely uninstall clausona:")}`,
          `    ${dim("• Strip symlinks and restore backups for all non-primary profiles")}`,
          `    ${dim("• Profile directories at ~/.claude-<name> are preserved (data intact)")}`,
          `    ${dim("• Remove shell integration from rc files")}`,
          `    ${dim("• Delete ~/.clausona/ directory (registry, usage, backups)")}`,
          `    ${dim("• Delete app files and launcher binary")}`,
          "",
        ].join("\n") + "\n",
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
      const profileNames = Object.fromEntries(accounts.map((account) => [account.configDir, account.isPrimary ? "default" : path.basename(account.configDir).replace(/^\.claude-/, "")]));
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
    defaultProfile:
      existing?.activeProfile ??
      Object.values(profileNames)[0] ??
      "default",
  };
}
