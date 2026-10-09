# Extensions

[← Back to the README](../README.md)

`clausona skills`, `clausona mcp` and `clausona hooks` list the skills, MCP servers and hooks
that Claude Code and Codex load, for every account clausona manages, seen from one project.
The dashboard's Extensions screen shows the same rows.

The commands and the screen only read files. In this version nothing here changes a file. A
later version adds ways to turn things off and to delete them, each with a confirm step and an
undo.

`csn` is the same command as `clausona`. The examples use the fictional accounts `personal`
and `work`, the projects `~/app` and `~/site`, and a plugin `kit@demo`.

- [Projects, rows and accounts](#projects-rows-and-accounts)
- [Scopes](#scopes)
- [States and tags](#states-and-tags)
- [Reading the tables](#reading-the-tables)
- [CLI reference](#cli-reference)
- [JSON](#json)
- [Safety](#safety)
- [Recipes for agents](#recipes-for-agents)
- [On the screen](#on-the-screen)

## Projects, rows and accounts

Everything is seen from one project. It is the git root that holds the current directory, or
the directory itself outside a repository. The home folder can be the project too.
`--project <path>` looks from another one, and on the screen the project list picks one (see
[On the screen](#on-the-screen)). At the filesystem root there is no project.

The other projects are the folders that Claude Code or Codex recorded in any account and that
still exist.

The lists are made of rows. A row is one thing, even when several accounts hold their own copy
of it:

- a Claude MCP server that several accounts' `.claude.json` define, as a user server or as a
  local server of the same project;
- a Cloud skill that several accounts have;
- a plugin installed in several accounts, and each skill, server and hook it brings.

Such a row lists all its copies. Every other item is a row of its own. An account's own skills
folder, one that is not linked to the primary's, is a folder of its own, so its skills are one
row per account.

The text output names an account by its short name (`work`), JSON by its profile id
(`claude:work`). `--account` takes either.

## Scopes

A scope is a place things come from. Two of them, Loaded and Not used in 90 days, are
worked out from the others.

| Scope | `--scope` | Applies to | Its header on the screen |
|---|---|---|---|
| Loaded | `loaded` | every tool and kind | `what Claude Code loads in ~/app, in at least one account` |
| Project | `project` | every tool and kind | the project's own files, listed below |
| Parent folders | `parents` | Claude MCP | `.mcp.json in ~/repos · loads here too` |
| Global | `global` | every tool and kind | the user's own files, listed below, then `· loads in every project` |
| Cloud | `cloud` | Claude skills | `skills on your claude.ai accounts, different per account` |
| Plugins | `plugins` | Claude skills, MCP and hooks | `plugins that bring skills, installed for you or for this project` |
| Built-in | `builtin` | Claude and Codex skills | Claude: `skills that come with Claude Code · only the ones your settings name`; Codex: `skills that come with Codex · in its skills/.system folder` |
| Managed | `managed` | Claude MCP and hooks | `your organization's managed settings · apply in every project` |
| Other projects | `other` | every tool and kind, in the CLI | none: the screen has the project list instead |
| Not used in 90 days | `unused` | Claude skills | `not used in 90 days in any account, or never used and older than 14 days` |

The header says "runs" for hooks and names MCP servers or hooks where the table above says
skills. Codex's Loaded reads `what Codex loads in ~/app`, with no accounts: Codex
profiles share one configuration.

Project and Global are these files. The header names the folders it found.

| Tool, kind | Project (in `~/app`) | Global |
|---|---|---|
| Claude skills | `.claude/skills` and `.claude/commands` | `~/.claude/skills` and `~/.claude/commands`, and an account's own `skills` and `commands` folders |
| Claude MCP | `.mcp.json`, and each account's entry for the project in `.claude.json` | user servers in each account's `.claude.json` |
| Claude hooks | `.claude/settings.json` and `.claude/settings.local.json` | `~/.claude/settings.json` |
| Codex skills | `.agents/skills` | `~/.agents/skills` and the `skills` folder of Codex's home |
| Codex MCP | `.codex/config.toml` | `config.toml` in Codex's home |
| Codex hooks | `.codex/hooks.json` | `hooks.json` in Codex's home |

`~/.claude` stands for the primary Claude Code folder, which every account's `settings.json`
and `skills` link to. Codex's home is the primary Codex folder, `~/.codex` by default.

The screen lists the scopes of each tool and kind in this order:

| Tool, kind | Scopes |
|---|---|
| Claude skills | Loaded, Project, Global, Cloud, Plugins, Built-in, Not used in 90 days |
| Claude MCP | Loaded, Project, Parent folders, Global, Plugins, Managed |
| Claude hooks | Loaded, Project, Global, Plugins, Managed |
| Codex skills | Loaded, Project, Global, Built-in |
| Codex MCP | Loaded, Project, Global |
| Codex hooks | Loaded, Project, Global |

The screen always shows Loaded and Project, and the others only when they hold something.
The CLI takes every scope its command has, for either tool, and says so when one is empty. It
also has Other projects, `--scope other`. [Scope values](#scope-values) lists them all.

Some scopes need a word more:

- Project for Claude MCP includes local servers: the ones an account added for this
  project with `claude mcp add`, kept in that account's `.claude.json`.
- Parent folders: Claude Code reads `.mcp.json` in the project and in every folder above
  it. The header names each folder, nearest first.
- Cloud: the skills Claude Code downloaded from each account's claude.ai skills, under
  `~/.claude/skills/synced`.
- Plugins lists the plugins themselves (rows of kind `plugin`) that bring at least one
  thing of the kind, installed for everyone or for this project. A plugin installed only for
  another project is under Plugins seen from that project, and under Other projects in the CLI.
  In JSON a plugin row has `contains`, the names of what it brings. What a plugin brings is in
  Loaded while the plugin is on, and in `all`, with the plugin's name as WHERE.
- Built-in: skills that come with the tool itself. You can turn them off, but not delete
  them.
  - Claude Code keeps its built-in skills (such as `claude-api`) inside the program, not
    in files, so clausona lists only the names your `skillOverrides` mention and no skill on
    disk answers to. It cannot tell a built-in skill from one removed since, so it lists
    both. Shown only when there is one.
  - Codex keeps them in the `skills/.system` folder of its home, which it fills itself.
- Managed: the administrator's managed settings, `managed-settings.json` and the files in
  `managed-settings.d/`. In this version that means hooks: clausona reads no managed MCP file,
  so `mcp ls --scope managed` is always empty.
- Other projects, in the CLI only: `ls --scope other` lists the rows of every other project at
  once, each with its `project`. On the screen, pick that project from the project list to see
  its rows.

### Loaded

Loaded is the union of what loads in this project:

- what no project owns: Global, Cloud, built-in and managed items;
- what an enabled plugin brings, installed for everyone or for this project;
- this project's own items;
- the `.mcp.json` servers of this folder and the folders above it.

Then it takes out what is off, a `.mcp.json` server still pending approval, a skill whose link
is broken (there is no `SKILL.md` to read), and a copy that a same-name copy wins over. For
Claude, a row is in Loaded when it loads in at least one account.

### Which copy wins

Claude Code loads one copy of a name. clausona works out which one as Claude Code does, account
by account.

For skills, Claude Code ranks managed first, then personal (Global), then project. clausona
reads no managed skills, so in practice a Global skill wins over a Project skill of the same
name. A skill in the primary's skills folder wins in every account. A skill in one account's
own skills folder wins in that account only.

For MCP servers, Claude Code takes one server per name: the account's local server first, then
the `.mcp.json` ones, then the account's user server. Of two `.mcp.json` files, the nearest
wins. A `.mcp.json` copy wins over a user server only once it is approved for that account,
because Claude Code leaves out a pending or denied one before it picks. So with a user `github`
and a `.mcp.json` `github` that no one has approved, the user copy loads and the `.mcp.json`
one is `pending approval`.

The copy that loses is tagged with the scope of the one that wins: `hidden by Global copy` for
a Global skill, `hidden by Project copy` for a local server or this project's `.mcp.json`, and
`hidden by Parent folders copy` for a `.mcp.json` in a folder above. It gets the tag only when
it loses in every account that has it, and is then not in Loaded. When it loses in some
accounts only, it still loads here, with no `hidden by` tag, and its details say where it is
hidden: `Loaded  on in personal · hidden by the Global copy in work`.

`skillOverrides` and `enabledPlugins` are read the way Claude Code reads them: managed
settings first, then the project's `.claude/settings.local.json`, then its
`.claude/settings.json`, then the user settings. The first that sets a name wins.

## States and tags

The `state` of an item in JSON is one of these:

| State | Meaning |
|---|---|
| `on` | The switch is on. It loads unless a tag says `hidden by …` or `broken link`. |
| `off` | It is turned off. |
| `name-only` | A Claude skill set to `name-only` in `skillOverrides`. The details say "Shows as name only". |
| `user-invocable-only` | A Claude skill set to `user-invocable-only` in `skillOverrides`. The details say "Shows as only when you call it". |
| `pending-approval` | A `.mcp.json` server not approved yet. Claude Code does not start it. |
| `mixed` | The accounts differ: `stateByAccount` has each one's. |

`state` is the switch's value and nothing more. A row loads here when its state is `on`,
`name-only` or `user-invocable-only` and no tag says `hidden by …` or `broken link`. A hidden
copy and a broken link keep their own `state`; only the tags say they do not load. A `mixed`
row loads in the accounts whose `stateByAccount` value is `on`, except where another copy wins
there, which its details say.

The switches are read from these places:

- Claude skills: `skillOverrides` in the settings files.
- Claude plugins and what they bring: `enabledPlugins` in the settings files. A plugin no
  settings file turns on is off.
- Claude user and local MCP servers: `disabledMcpServers` in the account's `.claude.json`
  entry for the project, which is what `/mcp disable` writes. With no project they are on. A
  plugin's server is off while its plugin is off, and each account can turn it off the same
  way.
- `.mcp.json` servers: `enabledMcpjsonServers`, `disabledMcpjsonServers` and
  `enableAllProjectMcpServers`, in the settings files or the account's project entry.
- Codex skills: `[[skills.config]]` in Codex's `config.toml`, by name or by path.
- Codex MCP servers: `mcp_servers.<name>.enabled` in Codex's or the project's `config.toml`.
- Hooks are on, except a plugin's hooks while the plugin is off.

### Tags

A row can carry several tags. They are listed most important first: `broken link`, then
`off`, `off here` or `off in N of M accounts`, then `pending approval`, then
`hidden by … copy`, then `unused`. The NOTE column shows the first; JSON `tags` has them all.

| Tag | When |
|---|---|
| `broken link` | The skill's folder is a link whose target is missing. It does not load, so it is not in Loaded. |
| `off` | Off in every account that has it, by a user or managed setting, or because nothing turns it on (a plugin no settings file enables). |
| `off here` | Off in every account by this project's own settings: its `.claude/settings*.json`, an account's entry for it in `.claude.json`, or its `.codex/config.toml`. |
| `off in N of M accounts` | Off in N accounts and on in the others. M counts the accounts that have the row; for a server every account sees, the accounts that have opened this project. |
| `pending approval` | A `.mcp.json` server that no account has approved in this project. |
| `hidden by Project copy` | In every account that has it, a same-name copy in Project wins: the account's local server, or this project's `.mcp.json`. |
| `hidden by Global copy` | In every account that has it, a same-name skill in Global wins: the primary's, or the account's own. |
| `hidden by Parent folders copy` | In every account that has it, a same-name `.mcp.json` copy in a parent folder wins. |
| `unused` | A Claude skill the rule below calls unused. |

The three `hidden by` tags are the forms of `hidden by <scope> copy`, which names the scope of
the copy that wins. [Which copy wins](#which-copy-wins) says which copy that is.

### Not used in 90 days

The rule uses two constants, `CLEANUP_UNUSED_DAYS = 90` and `CLEANUP_GRACE_DAYS = 14`.

- It covers Claude skills only. Codex keeps no record of use.
- It covers the skills you can delete one at a time: those in Global (an account's own folder
  too), this project and every other project. WHERE reads Project for this project's own and
  names any other project. Cloud, plugin and built-in skills are left out.
- A skill is unused when its last use, in any account, was more than 90 days ago.
- A skill that was never used is unused when its folder is more than 14 days old. Its age is
  the folder's birth time, or its modification time where there is none. The details say it:
  `Used  never, in any account · added 3d ago`.
- A broken link is listed too. Its tag is `broken link`.
- A skill used with no time recorded is not called unused. Neither is a never-used skill
  whose age could not be read.

Use comes from Claude Code's `skillUsage` in each account's `.claude.json`, summed over the
accounts and counted by skill name. A Cloud skill is also counted under
`anthropic-skills:<name>`. Because the count is by name, a hidden copy and the copy that wins
over it share one count.

## Reading the tables

`ls` prints a title line, a blank line and a table.

```
$ csn skills ls
8 skills · Loaded · project ~/app

NAME           TOOL    WHERE               USES  LAST USED  NOTE
deploy-check   claude  Project             9     5d ago
eli5           claude  Global              613   38m ago
eli5           codex   Global              —     —
kit:plan       claude  kit                 0     never
old-notes      claude  Global              0     never      unused
pdf            claude  Cloud · 2 accounts  0     never
pr-summary     claude  Global              3     4mo ago    unused
skill-creator  codex   Built-in            —     —
```

The columns:

- NAME is what `show` takes. A plugin's skill is `<plugin>:<name>`, a plugin's server
  `plugin:<plugin>:<name>`, a plugin `<plugin>@<marketplace>`, and a hook `<Event>` or
  `<Event> <matcher>`.
- TOOL appears only when both tools are listed.
- WHERE is where the row comes from: `Project`, `Global`, `Cloud`, the plugin's name, a
  parent folder's `.mcp.json` such as `~/repos/.mcp.json`, `Built-in`, `Managed`, or another
  project's name. It adds ` · work` for one account's own skill, ` · 2 accounts` for Cloud
  copies, and ` · command` for a legacy command file.
- USES and LAST USED (skills): the uses summed over accounts, and how long ago the
  last one was (`38m ago`, `5d ago`, `4mo ago`). A skill never used reads `0` and `never`. A
  hidden copy, a Codex skill and a plugin row read `—` in both.
- ACCOUNTS (MCP): `all` when every Claude account has it; `N of M` when N of the M Claude
  accounts do; the one account's short name; `—` for Codex.
- WHEN and RUNS (hooks): the event in plain words, and the command or prompt it runs
  with `~` for the home folder.
- NOTE: the first tag.

`--scope plugins` lists plugins, so its table is NAME, TOOL, CONTAINS and NOTE for skills, MCP
and hooks alike. CONTAINS says what each plugin brings, every kind: `4 skills · 1 hook`.

The title says how many rows, the scope, and the project. A scope with no rows prints one
sentence instead of the table, such as "Nothing in this project's own files." When the
terminal is narrow, long cells are cut with `…`; JSON is never cut.

### Hook events

| Hook name | WHEN |
|---|---|
| `PreToolUse Bash` | Before Bash runs |
| `PreToolUse` | Before any tool runs |
| `PostToolUse Edit` | After Edit runs |
| `PostToolUseFailure Bash` | After Bash fails |
| `UserPromptSubmit` | When you send a message |
| `Notification` | When Claude sends a notification |
| `Stop` | When Claude finishes replying |
| `SubagentStop` | When a subagent finishes |
| `SessionStart` | When a session starts |
| `SessionStart startup` | When a session starts (startup) |
| `SessionEnd` | When a session ends |
| `PreCompact` | Before the conversation is compacted |
| `PermissionRequest` | When Claude asks for permission |
| `Interrupt` | When you interrupt |
| `StopFailure` | When replying fails |

A matcher of `*` on a tool event reads "any tool". An event clausona does not know is shown by
its name. A Codex hook names Codex where these name Claude: its `Stop` reads "When Codex
finishes replying".

## CLI reference

```
clausona skills ls   [--scope <scope>] [--tool claude|codex] [--project <path>] [--json]
clausona skills show <name> [--tool claude|codex] [--scope <scope>] [--id <id>]
                     [--project <path>] [--json]
clausona mcp    ls   [--scope <scope>] [--tool claude|codex] [--account <name>]...
                     [--project <path>] [--json]
clausona mcp    show <name> [--tool claude|codex] [--scope <scope>] [--id <id>]
                     [--account <name>]... [--project <path>] [--json]
clausona hooks  ls   [--scope <scope>] [--tool claude|codex] [--project <path>] [--json]
clausona hooks  show <id|name> [--tool claude|codex] [--scope <scope>] [--id <id>]
                     [--project <path>] [--json]
```

With no subcommand, `ls` runs: `csn skills --scope project` is `csn skills ls --scope project`.
`--help` or `-h` prints the command's help; `ls --help` and `show --help` print their own pages.
Those two say where ids come from and link to this page online, at its JSON and
[Ids and row keys](#ids-and-row-keys) sections.

| Option | Meaning |
|---|---|
| `--scope <scope>` | For `ls`, the scope to list, `loaded` by default. For `show`, the one scope to look in. |
| `--tool <tool>` | `claude` or `codex`. Both by default. |
| `--project <path>` | Look from another project. A relative path is read from the current directory, and a leading `~` is the home folder, so `--project '~/app'` works without a shell. It must be a directory, and its git root is used, as for the current directory. |
| `--account <name>` | MCP only. In Loaded, the default scope, keep the rows that load for this Claude account; in any other scope, the rows it has, on or off. Give it more than once for several accounts. It takes `work` or `claude:work`, lists Claude rows only, and cannot be used with `--tool codex`. |
| `--id <id>` | `show` only. A row key or a copy's id, from `ls --json`. |
| `--json` | Print JSON version 1, described under [JSON](#json). |

A value can follow its option as `--scope project` or `--scope=project`. A value cannot start
with `-`. An unknown option, a value that is not in the list, a name after `ls`, `--account`
outside `mcp` and `--id` with `ls` are all bad usage, exit code 2.

### Scope values

| Value | Scope | skills | mcp | hooks |
|---|---|---|---|---|
| `loaded` | Loaded, the default | ✓ | ✓ | ✓ |
| `project` | Project | ✓ | ✓ | ✓ |
| `parents` | Parent folders | | ✓ | |
| `global` | Global | ✓ | ✓ | ✓ |
| `cloud` | Cloud | ✓ | | |
| `plugins` | Plugins | ✓ | ✓ | ✓ |
| `builtin` | Built-in | ✓ | | |
| `managed` | Managed | | ✓ | ✓ |
| `other` | Other projects | ✓ | ✓ | ✓ |
| `unused` | Not used in 90 days | ✓ | | |
| `all` | every place at once | ✓ | ✓ | ✓ |

`all` is the places together, each row once: Project, Parent folders, Global, Cloud, Plugins,
the built-in scope, Managed and Other projects. In place of each plugin it lists what the plugin
brings of the kind, on or off, with the same row ids as in Loaded. So `hooks ls --scope all`
lists hooks only, and its title counts hooks. The title reads `All scopes` where a scope's
name would be, as in `4 hooks · All scopes · project ~/app`. The plugins themselves are in
`plugins`.

A scope that does not apply to a tool is empty for it: `csn skills ls --scope cloud --tool codex`
lists nothing.

### show

`show` takes one name, or an id in its place, or `--id <id>`. A name is matched exactly, case
included. It is the NAME column: `eli5`, `kit:plan`, `kit@demo`, `Stop`,
`"PreToolUse Bash"`. A plugin also goes by its name before the `@`: `kit` finds `kit@demo`. Two
plugins of one name from two marketplaces make that short name ambiguous.

Without `--scope`, `show` looks in tiers. The first tier that has a match decides:

1. Rows in Loaded.
2. If none match: rows in Project, Parent folders, Global, Cloud, Plugins, Built-in and
   Managed, whether they load here or not. This tier also holds
   what no scope lists, such as a skill of a plugin that is off.
3. If none match: rows in Other projects.

Exactly one match in that tier is shown. Several are ambiguous: `show` exits with code 2 and
lists the candidates of that tier only. So `csn skills show deploy-check` means the one that
loads here, even when another project has its own.

`--scope` replaces the tiers with that one scope. It takes every value `ls --scope` takes, and
looks in that scope's rows and in the rows that live there, such as what plugins bring under
`plugins`. With `--scope all` a plugin itself is not among them; it is under `plugins`.
`--tool` and `--account` narrow every tier. In Loaded, `--account` keeps the rows that
load for that account, as `ls` does; in the other tiers, the rows it has. It only picks which
rows match: the details still list every account.

```
$ csn skills show eli5
  ✘ 2 skills are named 'eli5':
    claude  global  —  —  --id 'skill:claude:global:-:eli5'
    codex   global  —  —  --id 'skill:codex:global:agents:eli5'
    Pick one with --tool, --scope or --id <id>.
```

The candidate lines give the tool, the scope, the project, the account and the id to pass.

```
$ csn skills show eli5 --tool claude
GLOBAL › eli5

Explain any topic at the reader's level

File      ~/.claude/skills/eli5/SKILL.md
Loaded    on in every account, every project
Used      613 times · last 38m ago
          personal 412 · work 201
Also in   Claude › Project (different content)
          Codex › Global (same content)
```

A skill never used says when it was added, `never, in any account · added 3d ago`, so the
14 days' grace of the not-used rule can be read off it. A Codex row says its state in one
`Loaded` line, such as `on in every project` or `off everywhere (~/.codex/config.toml)`, and
names no account: Codex profiles share one configuration.

```
$ csn mcp show github
GLOBAL › github

Runs      npx -y @modelcontextprotocol/server-github
Secrets   GITHUB_TOKEN (value hidden)
Accounts  personal  on
          work      off (this project's entry in ~/.claude-work/.claude.json)
File      ~/.claude.json
          ~/.claude-work/.claude.json
```

### Ids and row keys

Every item has an id, `<kind>:<tool>:<scope>:<owner>:<name>`, built from where it is stored.
The owner part can hold a profile id or an absolute path, so treat an id as an opaque string:
copy it from `--json` and pass it back as it is.

A row of copies has a row key. It is the same with one copy as with many:

| Row | Key |
|---|---|
| A Claude MCP server in accounts' `.claude.json` | `mcp:claude:<account or local>:<project or ->:<name>` |
| A Cloud skill | `skill:claude:synced:-:<name>` |
| A plugin install | `plugin:claude:<install scope>:<project or ->:<plugin id>` |
| What a plugin install brings | `<kind>:claude:plugin:<install scope>:<project or ->:<plugin id>:<name>` |

The first part after `mcp:claude:` is `account` for a user server and `local` for a local one.
`<project>` is the project's absolute path, lower-cased on Windows, and `-` when there is none.
The install scope is `user`, `project` or `local`. A plugin's hook adds its place in its file,
as in `hook:claude:plugin:user:-:kit@demo:SessionStart#0.0`, so two hooks on one event are two
rows.

Ids and keys name where a thing is stored, not where it is seen from. They are the same from
every project, so an agent can store one and pass it to `show --id` later. A row key stays the
same when a plugin updates; a copy's id holds the plugin's install folder, which changes. A
hook's id holds its place in its file (`#<group>.<index>`), which moves when hooks above it are
added or removed.

`--id`, and a name given as an id, take a row key or the id of any copy. A copy's id picks its
whole row.

### Output, errors and exit codes

Text and JSON go to stdout. An error goes to stderr as one plain-text line or block, with
`--json` too. The one exception is an ambiguous name with `--json`: its object goes to stdout
and stderr stays empty. A JSON body for the other errors is a planned follow-up.

| Code | When |
|---|---|
| 0 | OK |
| 1 | Not found, or another failure, such as clausona not set up yet |
| 2 | Bad usage, an unknown option, or an ambiguous name |

A name nothing has prints `No skill named 'nope'.` and exits 1. When `--tool`, `--scope` or
`--account` narrowed the search, it adds "Leave out --tool, --scope or --account to look
further."

When a file cannot be read, the text output ends with "Could not read every file, so this
list may miss what they hold:" and each file, with a position or a reason and never what it
holds. JSON lists them in `warnings`. The exit code stays 0.

## JSON

`ls --json` prints one object, the envelope. `show --json` prints one item, with `version`
first and `details` last. Both are indented with two spaces. Paths are absolute; the text
output writes `~` for the home folder, JSON does not.

### The envelope

| Field | Type | Meaning |
|---|---|---|
| `version` | number | `1`. |
| `command` | string | `skills`, `mcp` or `hooks`. |
| `project` | string or null | The project the list is seen from. |
| `scope` | string | The `--scope` value, `loaded` by default. |
| `tools` | string[] | `["claude", "codex"]`, or the one `--tool` named. `["claude"]` with `--account`. |
| `items` | object[] | One item per row, by name, Claude's before Codex's. |
| `warnings` | object[] | `{ file, message }` for each file that could not be read. |

### Item fields

Each item has these keys, in this order. A key marked "when set" is left out when it does not
apply; the others are always there, `null` when empty.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The row key for a row of copies, else the item's id. Pass it to `show --id`. |
| `kind` | string | `skill`, `mcp`, `hook`, or `plugin` for a plugin's own row. |
| `tool` | string | `claude` or `codex`. |
| `name` | string | The name `show` takes. |
| `scope` | string | Where the row lives, seen from the project: `project`, `parents`, `global`, `cloud`, `plugins`, `builtin`, `managed` or `other`. Never `loaded` or `unused`, which are worked out. The field to read for where a row lives: its values are stable. |
| `from` | string | Display text, the WHERE label: `Project`, `Global`, `Cloud`, a plugin's name, a parent folder's `.mcp.json`, another project's name, `Built-in`, `Managed`. Its wording can change within version 1. |
| `project` | string or null | The project the row belongs to, or the folder of a parent `.mcp.json`. `null` for what no project owns. |
| `plugin` | string | When set: the plugin, `<plugin>@<marketplace>`, for a plugin row and what a plugin brings. |
| `accounts` | string[] | When set: the profile ids of the accounts that have the row, primary first. Set when the row is held, switched or hidden per account. |
| `state` | string | One of the states above, or `mixed` when the accounts differ. |
| `stateByAccount` | object | When set: profile id to state, for a row read per account. |
| `usage` | object or null | Claude skills only: `{ total, lastUsedAt, byAccount }`. `null` otherwise. |
| `tags` | string[] | Every tag that applies, most important first. |
| `file` | string | The file or folder that defines the row. For a row of copies, the first copy's. |
| `copies` | object[] | When set: for a row of copies, each copy, primary first. |
| `description` | string or null | The skill's or plugin's description. |
| `alsoIn` | object[] | Skills: same-name skills elsewhere, in either tool. Empty for the other kinds. |
| `link` | object | When set: a skill whose folder is a link, `{ target, broken }`. |
| `summary` | object | MCP servers and hooks only: what it runs, with secrets hidden. |
| `contains` | object | When set: a plugin row's contents, `{ skill, mcp, hook }`. |

The parts of the larger fields:

- `usage.total` is the uses summed over accounts; `usage.lastUsedAt` an ISO 8601 time, or
  `null` when never used; `usage.byAccount` the count per profile id. A hidden copy reports
  the count of the copy that wins over it, since Claude Code counts by name.
- `file` is a skill's folder (a legacy command's `.md` file), a server's or hook's settings or
  config file, a plugin's install folder, or for a Claude built-in skill the settings file
  that names it.
- Each of `copies` is `{ id, account, file }`, or `{ id, accounts, file }` for a plugin
  install, which every account that has it shares.
- Each of `alsoIn` is `{ tool, scope, project, sameContent }`. `sameContent` is `true`,
  `false`, or `null` when the folders were not compared.
- An MCP `summary` has `transport`, `command` or `url`, and `env` and `headers` with the names
  only, comma-separated. A hook `summary` has `event`, `matcher`, `type`, and `command` or
  `prompt`.
- `contains` is set on `kind: "plugin"` rows only. Each of `skill`, `mcp` and `hook` is a sorted
  list of the row names of what the plugin brings, the names `show` takes, such as
  `{ "skill": ["kit:plan"], "mcp": [], "hook": ["SessionStart"] }`. There is one name per row,
  so two hooks on one event are listed twice.

A row of copies, as `csn mcp ls --json` prints it:

```json
{
  "id": "mcp:claude:account:-:github",
  "kind": "mcp",
  "tool": "claude",
  "name": "github",
  "scope": "global",
  "from": "Global",
  "project": null,
  "accounts": ["claude:personal", "claude:work"],
  "state": "mixed",
  "stateByAccount": { "claude:personal": "on", "claude:work": "off" },
  "usage": null,
  "tags": ["off in 1 of 2 accounts"],
  "file": "/home/you/.claude.json",
  "copies": [
    { "id": "mcp:claude:account:claude:personal:github", "account": "claude:personal", "file": "/home/you/.claude.json" },
    { "id": "mcp:claude:account:claude:work:github", "account": "claude:work", "file": "/home/you/.claude-work/.claude.json" }
  ],
  "description": null,
  "alsoIn": [],
  "summary": { "transport": "stdio", "command": "npx -y @modelcontextprotocol/server-github", "env": "GITHUB_TOKEN" }
}
```

### show --json

`show --json` prints `"version": 1`, the item's fields, then `details`: the lines of the text
view, in order. Each line is an object with `text`, and with `label` and `tone` when they
apply.

- The first line is the title, such as `GLOBAL › eli5`, with no `label`.
- A line with no `label` stands alone, such as a description.
- A `label` of `""` continues the line above.
- `tone`, when set, is `muted`, `warning` or `error`.

`details` is written for people to read. Its wording can change within version 1, so read the
item's own fields where they have what you need.

### The ambiguous error

With `--json`, a name that matches several rows prints this on stdout and exits 2:

```json
{
  "version": 1,
  "error": "ambiguous",
  "candidates": [
    { "id": "skill:claude:global:-:eli5", "tool": "claude", "scope": "global", "project": null, "account": null },
    { "id": "skill:codex:global:agents:eli5", "tool": "codex", "scope": "global", "project": null, "account": null }
  ]
}
```

Each of `candidates` has `id`, the row's id to pass to `--id`; `tool`; `scope`; `project`, or
`null`; and `account`, the profile id when the row is one account's single copy, else `null`.
They are the candidates of one tier (see [show](#show)).

### Versioning

Every JSON output starts with `"version": 1`: the `ls` envelope, the `show` item and the
ambiguous error. Within version 1, keys can be added, and new values can appear in `scope`,
`state`, `tags`, `summary` and `contains`. A key keeps its name, type and meaning. A change
that breaks this comes with `version: 2`.

`from` and `details` are display text, written for people: their wording can change within
version 1. Read `scope` for where a row lives and `tags` for what holds it back.

So check `version`, read keys by name, and skip the ones you do not know.

## Safety

These commands and the screen only read. They never write, lock or move a file of Claude Code
or Codex, and they keep no cache: each run reads the files as they are.

Secret values stay out of every output, the screen, the text and `--json`:

- An MCP server's env and header values are never copied out of its config. Only their names
  are shown, such as `GITHUB_TOKEN (value hidden)`.
- In a command line, a URL or a hook's command, a value that looks like a secret reads
  `<hidden>`, such as the word after `--api-key` or a token in a URL.
- A warning about a file names the file and a position in it, never what the file holds.

Nothing leaves the machine. Listing makes no network call.

## Recipes for agents

Each recipe is a question, the command, and what to read in the JSON. The `jq` lines are one
way to read it.

### What loads in this project?

```bash
csn skills ls --json
csn mcp ls --json
csn hooks ls --json
```

Each item loads here in at least one account. `tool` says which tool, `from` where it comes
from. For a Claude MCP server, `stateByAccount` says which accounts load it, and the tag
`off in N of M accounts` marks a split. Add `--project <path>` to ask about another project.

### Which skills does this project define?

```bash
csn skills ls --scope project --json
```

Read `name` and `file`, the skill's folder. Claude's come from `.claude/skills` and
`.claude/commands`, Codex's from `.agents/skills`. A Claude skill tagged
`hidden by Global copy` is defined here, but a Global skill of the same name loads instead.

### Which Claude skills haven't been used in 90 days?

```bash
csn skills ls --scope unused --tool claude --json
csn skills ls --scope unused --tool claude --json \
  | jq -r '.items[] | [.name, .scope, (.usage.lastUsedAt // "never"), .file] | @tsv'
```

Read `usage.lastUsedAt` (`null` means never used), `usage.total`, `scope` and `project` for
where it lives, and `file` for its folder. A `broken link` tag means the folder is a link to
nothing. Cloud and plugin skills are never in this list.

### Which accounts have MCP server X, and is it on here?

```bash
csn mcp show github --tool claude --json
csn mcp show github --tool claude --json | jq '{accounts, state, stateByAccount}'
```

`--tool claude` is there because accounts are Claude's. Without it, a Codex server with the
same name makes `show` find two servers, exit 2 and ask which one.

`accounts` lists the profile ids that have the server; an account not in it does not have it.
`stateByAccount` gives each one's state in this project: `on`, `off` or `pending-approval`.
It is each account's switch: where another copy of the name wins in an account, it still reads
that account's switch, and that account's line in `details` says the copy is hidden, as in
`hidden by the Project copy`.

A Codex server has no `accounts`, because Codex has no accounts here; its `state` is the one
state. A `.mcp.json` server in a project no account has opened has none either, and its `state`
merges every account's approvals.

A name in several places is not ambiguous by itself. Claude Code takes one server per name, so
a user `github` and this project's `.mcp.json` `github` make one row in Loaded, the copy
that wins (see [Which copy wins](#which-copy-wins)), and `show` shows that one. Only when two
copies each load in a different account, such as one account's local server and another's user
server, does `show` exit 2 and print `candidates`. Then add `--account work` for the one that
loads in `work`, or run it again with one `--id`. To list what one account has, on or off, run
`csn mcp ls --scope all --account work --json`.

### Which hooks run when Claude finishes replying?

```bash
csn hooks ls --tool claude --json \
  | jq '.items[] | select(.summary.event == "Stop") | {command: .summary.command, file, from}'
```

Loaded lists the hooks that run in this project, plugins' included. The event is in
`summary.event`; `Stop` is "When Claude finishes replying". `summary.command`, or
`summary.prompt`, is what runs, and `file` is where it is set. `csn hooks show Stop` shows
one; when several hooks are on Stop, it exits 2 and lists their ids.

## On the screen

Run `csn` and choose Extensions. Claude and Codex are tabs, and Skills, MCP and Hooks are the
second level. The scope list is on the left and the chosen scope's table on the right. At 100
columns or more both show; below that, one at a time: scopes, then the table, then the
details.

The project row sits above the scopes, with a rule under it. It names the project everything
is seen from, such as `▾ app (here)`. `(here)` marks the project of the folder you started
`csn` in, and with no project the row reads `▾ No project`.

`p`, or `↑` from Loaded to the row and then `enter`, opens the project list in the scope
list's place. The heading reads `PROJECT` with the kind on the right: `skills`, `MCP servers`
or `hooks`. The project you are looking from comes first. Every other project that Claude Code
or Codex recorded follows, by name, with the count of its own rows of this tool and kind, the
ones its Project scope lists. A project with none shows `—`. `No project` is last. When two
projects have the same folder name, the folder above is shown too, as in `work/site`.

Picking a project shows every scope as seen from it, and goes back to Loaded. The title bar
and the table's header name it. `esc` or `←` closes the list and changes nothing.

The screen's tables differ a little from the CLI's. They have no TOOL column, Loaded adds
FROM, and Codex skills show their description.

| Key | What it does |
|---|---|
| `tab` | Switch between Claude and Codex, back to Loaded. |
| `1` `2` `3` | Skills, MCP, Hooks, back to Loaded. |
| `↑` `↓` `pgup` `pgdn` | Move. `↑` from the first scope goes to the project row, `↓` comes back. |
| `→` or `enter` | From the scope list into the table. On the project row, the project list. |
| `enter` | On a row, its details. In the project list, look from that project. |
| `←` or `esc` | Back one step. `esc` on the scope list or the project row leaves the screen. In the project list, close it. |
| `/` | Search the table. `enter` keeps the search, `esc` drops it. |
| `p` | Open the project list, from anywhere but a search. |
| `m` | A matrix of servers by account: which account starts which server in this project. On Claude's MCP tab, with a project picked. |
| `r` | Read the files again. |
| `w` | The files that could not be read, when there are any. |

Search matches a row's name, description, file, summary values, and the text cells the table
shows. It does not match the numbers in USES and LAST USED.
