# Extensions

[← Back to the README](../README.md)

`clausona skills`, `clausona mcp` and `clausona hooks` list the skills, MCP servers and hooks
that Claude Code and Codex load, for every account clausona manages, seen from one project.
The dashboard's Extensions screen shows the same rows.

`ls` and `show` only read files. `off`, `on`, `visibility`, `rm` and `undo` change them, each
after a confirm step and behind a backup, and `undo` puts the last change back. The screen has
the same changes as keys.

`csn` is the same command as `clausona`. The examples use the fictional accounts `personal`
and `work`, the projects `~/app` and `~/site`, and a plugin `kit@demo`.

- [Projects, rows and accounts](#projects-rows-and-accounts)
- [Scopes](#scopes)
- [States and tags](#states-and-tags)
- [Reading the tables](#reading-the-tables)
- [CLI reference](#cli-reference)
- [Changing things](#changing-things)
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
row per account. That account does not load the primary's skills, so a Global skill lists only
the accounts that do. The same goes for the `commands` folder.

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
| Plugins | `plugins` | every tool and kind | `plugins that bring skills, installed for you or for this project` |
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
| Codex hooks | `.codex/hooks.json`, and `[hooks]` in `.codex/config.toml` | `hooks.json` in Codex's home, and `[hooks]` in its `config.toml` |

`~/.claude` stands for the primary Claude Code folder, which every account's `settings.json`
and `skills` link to. Codex's home is the primary Codex folder, `~/.codex` by default.

Codex looks for skills below its skills folders too, as Codex does: any folder with a
SKILL.md in it, down to six folders deep, through links, and in no folder whose name starts
with `.`.

The screen lists the scopes of each tool and kind in this order:

| Tool, kind | Scopes |
|---|---|
| Claude skills | Loaded, Project, Global, Cloud, Plugins, Built-in, Not used in 90 days |
| Claude MCP | Loaded, Project, Parent folders, Global, Plugins, Managed |
| Claude hooks | Loaded, Project, Global, Plugins, Managed |
| Codex skills | Loaded, Project, Global, Plugins, Built-in |
| Codex MCP | Loaded, Project, Global, Plugins |
| Codex hooks | Loaded, Project, Global, Plugins |

The screen always shows Loaded and Project, and the others only when they hold something.
Loaded has no line of its own there: it is the project row, the list's first line.
The CLI takes every scope its command has, for either tool, and says so when one is empty. It
also has Other projects, `--scope other`. [Scope values](#scope-values) lists them all.

Some scopes need a word more:

- Project for Claude MCP includes local servers: the ones an account added for this
  project with `claude mcp add`, kept in that account's `.claude.json`.
- Parent folders: Claude Code reads `.mcp.json` in the project and in every folder above
  it, past the home folder too, up to the filesystem root. So does clausona: a `.mcp.json` in
  `/Users` or `C:\Users` is listed here. The header names each folder, nearest first.
- Cloud: the skills Claude Code downloaded from each account's claude.ai skills, under
  `skills/synced` in the skills folder that account loads: `~/.claude/skills/synced` for the
  accounts that share the primary's, and its own for an account whose skills folder is its own.
  What such an account left in the primary's folder before is not listed, as no account loads
  it.
- Plugins lists the plugins themselves (rows of kind `plugin`) that bring at least one
  thing of the kind, installed for everyone or for this project. A plugin installed only for
  another project is under Plugins seen from that project, and under Other projects in the CLI.
  In JSON a plugin row has `contains`, the names of what it brings. What a plugin brings is in
  Loaded while the plugin is on, and in `all`, with the plugin's name as WHERE.

  A plugin's servers come from its `.mcp.json` and from what its `.claude-plugin/plugin.json`
  declares under `mcpServers`: servers inline, or the `.json` files of servers it names, in
  that order. A server name declared again replaces the earlier one, as Claude Code merges
  them, so the manifest's copy wins over the `.mcp.json` one. Its hooks come from
  `hooks/hooks.json` and from `plugin.json`'s `hooks` the same way. A hooks file holds its
  events under a top-level `hooks` object; Claude Code loads none of one that has them at its
  root, so clausona lists none of them and names the file among those it could not read. A path
  that leads out of the plugin's folder, through `..` or a link, is not read, as Claude Code does
  not load it. Nor is an MCP bundle (`.mcpb` or `.dxt`), which Claude Code unpacks itself.

  - Codex's plugins are the ones in the `plugins/cache` folder of its home, read from the
    version Codex loads. Each is `<plugin>@<marketplace>`, as `config.toml` names it. It brings
    what its `.codex-plugin/plugin.json`, or else `.claude-plugin/plugin.json`, names, or the
    contents of its `skills` folder, `.mcp.json` and `hooks/hooks.json`. A plugin installed from
    ChatGPT's catalog is left out: your ChatGPT account says whether it is on, not
    `config.toml`.
- Built-in: skills that come with the tool itself. You can turn them off, but not delete
  them.
  - Claude Code keeps its built-in skills (such as `claude-api`) inside the program, not
    in files, so clausona lists only the names your `skillOverrides` mention and no skill on
    disk answers to. It cannot tell a built-in skill from one removed since, so it lists
    both. Shown only when there is one.
  - Codex keeps them in the `skills/.system` folder of its home, which it fills itself.
- Managed: the administrator's managed settings, `managed-settings.json` and the files in
  `managed-settings.d/`, for hooks, and `managed-mcp.json` beside them for MCP servers. While
  `managed-mcp.json` is there, Claude Code starts its servers and no other, so every other
  Claude server reads `off`, in every account, and its details say
  `only the servers in …/managed-mcp.json start`. The `managedMcpServers` key of managed
  settings lists servers too, and Claude Code starts them beside `managed-mcp.json`'s. It
  takes only a remote server there: an `http`, `streamable-http` or `sse` type on an `https://`
  URL, with no command, no `${VAR}` in it, and a name of letters, digits, `-` and `_`. It drops
  any other entry, and so does clausona. A name in two managed files is the one that ranks
  higher's, a file in `managed-settings.d/` over `managed-settings.json`. The key does nothing in
  any other settings file.
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
name. A skill in the primary's skills folder wins in every account that loads it: the primary,
and each account whose skills folder is linked to the primary's, as `clausona doctor` reads the
link. A skill in one account's own skills folder wins in that account only. An account whose
skills folder is its own, or missing, does not load the primary's skills, so there a Global
skill hides no Project skill.

For MCP servers, Claude Code takes one server per name: your organization's first, the one in
`managed-mcp.json` and then the one in `managedMcpServers`, then the account's local server,
then the `.mcp.json` ones, then the account's user server. Of two `.mcp.json` files, the nearest
wins. A `.mcp.json` copy wins over a user server only once it is approved for that account,
because Claude Code leaves out a pending or denied one before it picks. So with a user `github`
and a `.mcp.json` `github` that no one has approved, the user copy loads and the `.mcp.json`
one is `pending approval`.

The MCP lists come after the pick: Claude Code takes one copy per name, then checks it against
`deniedMcpServers` and `allowedMcpServers`. So a copy the lists keep from starting still wins
its name, and the copies below it don't start either. Their details say why, as in
`hidden by the Project copy (itself off: deniedMcpServers in ~/.claude/settings.json)`.

Codex takes a server a trusted project's `.codex/config.toml` defines over your own of the same
name: it merges the project's table over yours, and starts that one. So there your copy is
`hidden by Project copy`, and Loaded has the project's. A project Codex does not trust leaves
yours in place.

The copy that loses is tagged with the scope of the one that wins: `hidden by Global copy` for
a Global skill, `hidden by Project copy` for a local server or this project's `.mcp.json`,
`hidden by Parent folders copy` for a `.mcp.json` in a folder above, and `hidden by Managed
copy` for a server your organization's settings bring. It gets the tag only when
it loses in every account that has it, and is then not in Loaded. When it loses in some
accounts only, it still loads here, with no `hidden by` tag, and its details say where it is
hidden: `Loaded  on in personal · hidden by the Global copy in work`.

`skillOverrides` and `enabledPlugins` are read the way Claude Code reads them: managed
settings first, then the project's `.claude/settings.local.json`, then its
`.claude/settings.json`, then the user settings. The first that sets a name wins. So are
`disableAllHooks` and `disableBundledSkills`: the first file that sets one to `true` or
`false` decides, so a project's `false` turns hooks back on there over a `true` in your user
settings.

## States and tags

The `state` of an item in JSON is one of these:

| State | Meaning |
|---|---|
| `on` | The switch is on. It loads unless a tag says `hidden by …` or `broken link`, or, for a Codex skill, `no front matter`, `invalid front matter`, `name too long` or `no description`, or, for a Codex hook, `invalid hooks file`, `not supported`, `empty command`, `empty tool`, `unknown event` or `invalid matcher`. |
| `off` | It is turned off. |
| `name-only` | A Claude skill set to `name-only` in `skillOverrides`. The details say "Shows as name only". |
| `user-invocable-only` | A Claude skill set to `user-invocable-only` in `skillOverrides`. The details say "Shows as only when you call it". |
| `pending-approval` | A `.mcp.json` server not approved yet: Claude Code does not start it. Or a Codex hook not trusted yet, or changed since it was: Codex does not run it. |
| `not-here` | A `.mcp.json` server of a folder that is no project, seen from a project outside that folder. It loads in each project below the folder, with that project's approvals, and has no state of its own: look from one of those projects with `--project`. |
| `mixed` | The accounts differ: `stateByAccount` has each one's. |

`state` is the switch's value and nothing more. A row loads here when its state is `on`,
`name-only` or `user-invocable-only` and no tag says `hidden by …` or `broken link`, or, for a
Codex skill, `no front matter`, `invalid front matter`, `name too long` or `no description`, or,
for a Codex hook, `invalid hooks file`, `not supported`, `empty command`, `empty tool`,
`unknown event` or `invalid matcher`.
A hidden copy, a broken link and a file Codex skips keep their own `state`; only the tags say
they do not load. A `mixed` row loads in the accounts whose `stateByAccount` value is `on`,
except where another copy wins there, which its details say. A row read per account says it
for each account in `loadsByAccount`.

A row is read in the project it loads in: this project for what loads here, and its own
project for another project's row, as `--scope other` lists them. So an Other projects row's
state and tags are that project's, the one WHERE names, not this one's.

The switches are read from these places:

- Claude skills: `skillOverrides` in the settings files. A built-in skill is off while
  `disableBundledSkills` is `true`, whatever `skillOverrides` says, and the details name the
  setting and its file: `off everywhere (disableBundledSkills in ~/.claude/settings.json)`.
- Claude plugins and what they bring: `enabledPlugins` in the settings files. A plugin no
  settings file turns on is off.
- Claude user and local MCP servers: `disabledMcpServers` in the account's `.claude.json`
  entry for the project, which is what `/mcp disable` writes. With no project they are on. A
  plugin's server is off while its plugin is off, and each account can turn it off the same
  way.
- `.mcp.json` servers: `enabledMcpjsonServers`, `disabledMcpjsonServers` and
  `enableAllProjectMcpServers`, in the settings files or the account's project entry.
- Every Claude server, before its own switch: `managed-mcp.json` (see [Scopes](#scopes)), then
  `deniedMcpServers` and `allowedMcpServers` in the settings files, a project's in that project
  only. A server either list keeps out is `off` in every account, and its details name the list
  and its file: `off (deniedMcpServers in …)` or `off (not in allowedMcpServers in …)`. They
  match as Claude Code matches them:
  - an entry is `serverName`, the server's name exactly; `serverCommand`, its command and every
    argument in order; or `serverUrl`, a URL pattern where `*` is anything, the host in any case,
    and a host written out in full on its scheme's default port only;
  - a denylist entry from any file keeps a server out, a managed one too;
  - once any file has an allowlist, a server must be on one: a stdio server by `serverCommand`
    once the lists have such an entry, a remote one by `serverUrl` likewise, else by its name.
    The lists of every file count together, or the managed ones alone when managed settings
    set `allowManagedMcpServersOnly`. An empty list keeps every server out. A server of
    `managedMcpServers` needs no entry, nor does one of `managed-mcp.json` unless its config
    uses `${VAR}`.
  - `${VAR}` and `${VAR:-default}` are expanded before they match, in an entry's command or URL
    and in a server's command, arguments or URL, as Claude Code expands them. A variable that is
    set gives its value, an empty one too. One that is not gives its default, and with none it
    stays as written, so an entry and a server that spell it alike still match. A plugin's
    server reads its own folder as `${CLAUDE_PLUGIN_ROOT}`. A `serverUrl` entry that a value
    brings a `*` into is one no allowlist takes, while a denylist still does.
  - What a variable expands from, as Claude Code 2.1.296 reads it. In a server's command,
    arguments or URL: the environment clausona runs in, with the `env` of your settings laid over
    it in the order Claude Code reads them, user settings, then the project's
    `.claude/settings.json`, then its `.claude/settings.local.json`, then managed settings, a
    later one winning a name. A project's own files count in that project only. In a list entry:
    the environment clausona runs in, with managed settings' `env` over it, and a
    `deniedMcpServers` entry also takes user and managed settings' `env` for a variable that
    neither sets and that has no default. When a match reads a variable, the details say so:
    `off (deniedMcpServers in …, with ${TOOLS} as your shell and settings set it)`.
  - A match can differ from Claude Code's where clausona does not model what Claude Code reads:
    when Claude Code starts in another environment than this shell, such as an IDE's or one a
    launcher sets (clausona's sets `CLAUDE_CONFIG_DIR` for each account but the default one);
    the `env` of an account's `.claude.json` and of a `--settings` file; the variables Claude
    Code leaves out of a settings file's `env`, in a folder it does not trust yet, names it keeps
    for itself, or a project's value for a name already set when it starts; its own credentials,
    which it reads as empty in a server's config and in an entry; a `serverUrl` entry it finds
    unsafe for another reason than a `*`, such as a value that changes the URL's shape or a
    whole URL in one variable, which no allowlist then takes; and `${CLAUDE_PROJECT_DIR}`,
    `${CLAUDE_PLUGIN_DATA}` and `${user_config.…}` in a plugin's server, which stay as written
    unless the environment sets them.
- Codex skills: `[[skills.config]]` in Codex's `config.toml`, by name or by path. A path names
  the skill whether it goes through a link or not, as Codex reads it.
- Codex MCP servers: `mcp_servers.<name>.enabled` in Codex's or the project's `config.toml`. A
  server a project's `config.toml` defines is `off` while Codex does not trust the project, as
  Codex leaves that file out: a same-name server of your own loads there instead. Its details
  say so, with the `Trust` line a switch there gets.
- Codex's trust: Codex looks for a `[projects."<folder>"]` with a `trust_level` in its
  `config.toml` in three places, and the first it finds decides. First the project's folder,
  then its project root: the nearest folder at or above it with a `.git`, or with one of the
  `project_root_markers` your `config.toml` sets. Then the repository's root, which for a linked
  worktree is the main checkout. So a worktree of a trusted repository, and a folder inside one,
  are trusted, unless their own entry says `untrusted`. Each folder matches by its real path or
  as you reached it; git names a worktree's main checkout by its real path, as Codex records a
  trust. A key matches only as written: a trailing slash, a `..`, forward slashes on Windows or
  another case of a letter elsewhere make it name no folder, as in Codex. On Windows a key
  matches in any case of its ASCII letters, and no others (`É` is not `é`), and the real path is
  Codex's spelling of it: long names, and `\\?\UNC\` kept for a network share or a mapped drive.
- Codex plugins and what they bring: a `[plugins."<plugin>@<marketplace>"]` table in Codex's or
  the project's `config.toml` turns a plugin on, and `enabled = false` in it turns it off. A
  plugin no table names is off. A plugin's skill is switched by its full name in
  `[[skills.config]]`, and its server by `plugins."<id>".mcp_servers.<name>.enabled`. A server
  the plugin ships with `"enabled": false` is off until that switch turns it on.
- Claude hooks are on, except a plugin's hooks while the plugin is off. `disableAllHooks` set to
  `true` turns every Claude hook off. Set in managed settings, it turns off the managed hooks
  too. Set anywhere else, it leaves the managed hooks on, and a plugin's hooks while managed
  `enabledPlugins` turns the plugin on, as Claude Code runs those. The details name the setting
  and its file, as in `off everywhere (disableAllHooks in ~/.claude/settings.json)`; a project's
  own setting reads `off here`.
- Codex hooks: Codex runs a hook only once you have trusted it with `/hooks` in Codex, as it
  is now. It keeps that in its `config.toml`, as `[hooks.state."<key>"]` with the hook's
  `trusted_hash`, and the key holds the path of the profile's `hooks.json`, so each Codex
  profile trusts a hook on its own. A hook trusted in at least one profile is `on`. One trusted
  in none, or changed since it was, is `pending-approval`, and `enabled = false` under every
  profile's key turns it `off`. A bundled plugin's cleanup hook runs without a review. A
  plugin's hooks are off while the plugin is off. A project's hooks are `off` while Codex does
  not trust the project, trusted themselves or not: Codex then leaves the project's `.codex`
  folder out. Their details say so, and why: `Trust  Codex does not trust this project, so it
  ignores its .codex folder.` Codex reads a hooks file only when it holds `hooks` and, at most,
  a `description` at its top, and every hook in it is one it can read: a known `type`, a string
  `command`, `server` and `tool`, a `timeout` or `additionalContextLimit` written as a whole
  number (`30`, not `30.0` or `3e1`, which Codex's JSON reading keeps as text), and so on. In a
  `config.toml` a float there makes Codex refuse the whole file, and so does a `[hooks.state]`
  entry that is no table, or whose `enabled` is no boolean or `trusted_hash` no string. The
  hooks of any other
  file are tagged `invalid hooks file`, and so are all of a plugin manifest's inline hooks when
  one of them is unreadable. A plugin whose `hooks` lists hook files and hooks together has
  none. Codex runs no prompt or agent hook yet, nor an MCP tool hook when a session ends: those
  are tagged `not supported`. It skips a command hook whose command is empty, or only spaces,
  and an MCP tool hook whose server or tool is, and runs the rest of its file: those are tagged
  `empty command` and `empty tool`. It reads its twelve events by their exact names and leaves
  any other alone, its hooks unread, so a hook on such an event is tagged `unknown event`. On
  the events that take a matcher, Codex compiles one that is not `*`, empty or plain names
  (letters, digits, `_` and `|`) as a Rust regex, and skips the whole group when it cannot:
  its hooks are tagged `invalid matcher`. Rust's regex is not JavaScript's: it has no
  lookaround (`(?=…)`) or backreferences, and takes `(?i)` and `\pL`. clausona checks the
  matcher as Rust's parser does, so it tags only what Codex skips for sure; a matcher Rust
  parses and then cannot compile, such as an unknown `\p{…}` name or one past its size limit,
  is not tagged. Codex
  also runs the hooks a `config.toml` holds, as `[[hooks.<Event>]]` tables, beside that folder's
  `hooks.json`: Codex's own and a trusted project's. Their key holds the `config.toml`'s path.
  clausona lists them and their trust, and leaves changing them to `/hooks` in Codex
  (`codex-config-hook`).
- Codex hooks in a linked git worktree: Codex runs the main checkout's hooks there, not the
  worktree's. It reads the `hooks.json` and the `config.toml` `[hooks]` of the `.codex` folder at
  the same place in the main checkout, and keys their trust by their paths there. The rest of the
  worktree's `.codex/config.toml`, its servers, switches and plugins, is the worktree's own. So in
  a worktree clausona lists the main checkout's hooks as the worktree's, with their trust under
  the main checkout's keys, and turning one off changes the main checkout's file, which git
  tracks there. The worktree's own hooks are tagged `main checkout's runs` and are not in
  Loaded. Their details name the main checkout's file, and clausona does not change them
  (`codex-worktree-hook`). In a worktree Codex does not trust, it runs neither, so their details
  and refusals say that first (`codex-untrusted`). This is only for a worktree with a `.codex`
  folder of its own: Codex runs no project hooks in one without.

### Tags

A row can carry several tags. They are listed most important first: `broken link`, then
`off`, `off here` or `off in N of M accounts`, then `not here`, then `pending approval`, then
`hidden by … copy`, then `unused`, then `no front matter`, then `invalid front matter`, then
`name too long`, then `no description`, then `main checkout's runs`, then `invalid hooks file`,
then `not supported`, then `empty command`, then `empty tool`, then `unknown event`, then
`invalid matcher`. The NOTE
column shows the first; JSON `tags` has them all.

| Tag | When |
|---|---|
| `broken link` | The skill's folder is a link whose target is missing. It does not load, so it is not in Loaded. |
| `off` | Off in every account that has it, by a user or managed setting, or because nothing turns it on (a plugin no settings file enables). |
| `off here` | Off in every account by this project's own settings: its `.claude/settings*.json`, an account's entry for it in `.claude.json`, or its `.codex/config.toml`. |
| `off in N of M accounts` | Off in N accounts and on in the others. M counts the accounts that have the row; for a server every account sees, the accounts that have opened this project. |
| `not here` | A `.mcp.json` server of a folder that is no project, seen from a project outside it: the state `not-here`. |
| `pending approval` | A `.mcp.json` server that no account has approved in this project, or a Codex hook not trusted yet with `/hooks`, or changed since it was. |
| `hidden by Project copy` | In every account that has it, a same-name copy in Project wins: the account's local server, or this project's `.mcp.json`. For Codex, a server this project's `.codex/config.toml` defines, where Codex trusts the project. |
| `hidden by Global copy` | In every account that has it, a same-name skill in Global wins: the primary's, or the account's own. |
| `hidden by Parent folders copy` | In every account that has it, a same-name `.mcp.json` copy in a parent folder wins. |
| `unused` | A Claude skill the rule below calls unused. |
| `no front matter` | A skill whose `SKILL.md` has no front matter. Claude Code loads it under its folder's name, with no description, so it has only the skill's first non-empty line to tell when to use it: a quiet note, the skill still loads. Codex skips it, with no front matter between `---` lines, so a Codex one is not in Loaded. For Codex, a `SKILL.md` that starts with a byte order mark has none either. |
| `invalid front matter` | A Codex skill whose front matter is not YAML Codex reads: say, a quoted description with more text after its closing quote, a description line that runs on to the next line unindented, or a description written as a list. Codex skips it, so it is not in Loaded. A description with a `: ` in it is fine: Codex quotes it and reads it again, and so does clausona. |
| `name too long` | A Codex skill whose name is over 64 characters. Codex skips it, so it is not in Loaded. |
| `no description` | A Codex skill whose front matter has no `description`, or one that is empty or only spaces. Codex skips it, so it is not in Loaded. |
| `main checkout's runs` | A Codex hook in a linked git worktree's own `.codex` folder. Codex runs the main checkout's hooks there instead, so it is not in Loaded. Its details name the main checkout's file. |
| `invalid hooks file` | A Codex hook in a hooks file with more than `hooks` and a `description` at its top, such as its events, or a `$schema`, or with a hook Codex cannot read, such as a `command` that is not a string. Codex skips the whole file, so the hook does not run. |
| `not supported` | A Codex hook of a kind Codex does not run: a prompt or an agent hook, or an MCP tool hook on `SessionEnd`. Codex skips it, whatever its trust, so it is not in Loaded. |
| `empty command` | A Codex command hook whose command is empty or only spaces. Codex skips it, and runs the rest of its file, so it is not in Loaded. |
| `empty tool` | A Codex MCP tool hook whose server or tool is empty or only spaces. Codex skips it, and runs the rest of its file, so it is not in Loaded. |
| `unknown event` | A Codex hook on an event that is none of Codex's twelve, such as `Notification` or a `stop` in lower case. Codex leaves the event alone, so the hook is not in Loaded. |
| `invalid matcher` | A Codex hook whose group's matcher is not a regex Codex can compile, such as `(?=Bash)` or `Bash(`, on an event that takes a matcher. Codex skips the group, so the hook is not in Loaded. |

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
  `plugin:<plugin>:<name>` (in Codex, its own name), a plugin `<plugin>@<marketplace>`, and a
  hook `<Event>` or `<Event> <matcher>`. A Codex skill goes by the `name` in its SKILL.md's
  front matter, as Codex names it, or by its folder's name when that has none.
- TOOL appears only when both tools are listed.
- WHERE is where the row comes from: `Project`, `Global`, `Cloud`, the plugin's name, a
  parent folder's `.mcp.json` such as `~/repos/.mcp.json`, `Built-in`, `Managed`, or another
  project's name. It adds ` · work` for one account's own skill, ` · 2 accounts` for Cloud
  copies, and ` · command` for a legacy command file.

  A project goes by its folder's name. When two recorded projects have the same folder name,
  both go by the folder above it too, as in `work/app` and `personal/app`, here, in JSON's
  `from` and on the screen.
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
clausona skills off|on <name>... [--everywhere] [change options]
clausona skills visibility <name> <on|name-only|user-invocable-only|off> [--everywhere]
                     [change options]
clausona skills rm   <name>... [change options]
clausona skills undo [--dry-run] [--yes] [--json]
clausona mcp    ls   [--scope <scope>] [--tool claude|codex] [--account <name>]...
                     [--project <path>] [--json]
clausona mcp    show <name> [--tool claude|codex] [--scope <scope>] [--id <id>]
                     [--account <name>]... [--project <path>] [--json]
clausona mcp    off|on <name>... [--everywhere] [--account <name>]... [change options]
clausona mcp    rm   <name>... [--account <name>]... [change options]
clausona mcp    undo [--dry-run] [--yes] [--json]
clausona hooks  ls   [--scope <scope>] [--tool claude|codex] [--project <path>] [--json]
clausona hooks  show <id|name> [--tool claude|codex] [--scope <scope>] [--id <id>]
                     [--project <path>] [--json]
clausona hooks  off|on <id|name>... [change options]
clausona hooks  rm   <id|name>... [change options]
clausona hooks  undo [--dry-run] [--yes] [--json]

change options: [--tool claude|codex] [--scope <scope>] [--id <id>]... [--project <path>]
                [--tracked] [--dry-run] [--yes] [--json]
```

`visibility` takes one name or one `--id`, and no `--tool`: it is for Claude skills only.

With no subcommand, `ls` runs: `csn skills --scope project` is `csn skills ls --scope project`.
`--help` or `-h` prints the command's help, and every subcommand has a page of its own:
`csn skills rm --help`. `off --help` and `on --help` print the same page. The pages link to
this page online, at its JSON, [Ids and row keys](#ids-and-row-keys) and
[Changing things](#changing-things) sections.

| Option | Meaning |
|---|---|
| `--scope <scope>` | For `ls`, the scope to list, `loaded` by default. For `show`, `off`, `on`, `visibility` and `rm`, the one scope to look in. |
| `--tool <tool>` | `claude` or `codex`. Both by default. |
| `--project <path>` | Look from another project, and make a change there. A relative path is read from the current directory, and a leading `~` is the home folder, so `--project '~/app'` works without a shell. It must be a directory, and its git root is used, as for the current directory. |
| `--account <name>` | MCP only. In Loaded, the default scope, keep the rows that load for this Claude account; in any other scope, the rows it has, on or off. With `off`, `on` and `rm`, change this account only. Give it more than once for several accounts. It takes `work` or `claude:work`, lists Claude rows only, and cannot be used with `--tool codex`. |
| `--id <id>` | `show`, `off`, `on`, `visibility` and `rm`. A row key or a copy's id, from `ls --json`. `off`, `on` and `rm` take it more than once, for several rows; `show` and `visibility` take one. |
| `--everywhere` | `off`, `on` and `visibility`: in every project, not only this one. Hooks always change everywhere, so for them it changes nothing. See [Off and on](#off-and-on). |
| `--tracked` | `off`, `on`, `visibility` and `rm`: go ahead with a change to a file or folder git tracks, which changes the repo, or one git did not answer for in time. See [Delete](#delete). |
| `--dry-run` | `off`, `on`, `visibility`, `rm` and `undo`: print the plan and change nothing. |
| `--yes`, `-y` | `off`, `on`, `visibility`, `rm` and `undo`: do not ask first. Needed when there is no terminal, and with `--json`. |
| `--json` | Print JSON version 1, described under [JSON](#json). |

A value can follow its option as `--scope project` or `--scope=project`. A value cannot start
with `-`. An unknown option, a value that is not in the list, a name after `ls`, `--account`
outside `mcp` and `--id` with `ls` are all bad usage, exit code 2. So is an option the
subcommand does not take, such as `--everywhere` with `rm`, `--tool` with `visibility`, or a
name with `undo`.

An unknown subcommand is bad usage too, and says which ones there are:
`Unknown subcommand 'nope'. clausona skills takes ls, show, off, on, visibility, rm or undo. Run clausona skills --help.`
An unknown command, as in `csn nope`, prints `Unknown command 'nope'. Run clausona --help.` and
exits 2.

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
plugins of one name from two marketplaces make that short name ambiguous. A row of that very
name comes first, so in Codex `code-review` is the server even beside its plugin
`code-review@openai-bundled`.

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
File      ~/.claude.json · personal
          ~/.claude-work/.claude.json · work
```

A server in several accounts' `.claude.json` has a `File` line for each copy, with its account.

### Ids and row keys

Every item has an id, `<kind>:<tool>:<scope>:<owner>:<name>`, built from where it is stored.
The owner part can hold a profile id or an absolute path, so treat an id as an opaque string:
copy it from `--json` and pass it back as it is. A Codex skill's id ends in its folder, which its
name can differ from.

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
rows. A hook in `plugin.json`, or in a file it names, adds that file too:
`SessionStart#plugin.json:0.0`, `SessionStart#config/extra.json:0.0`.

Ids and keys name where a thing is stored, not where it is seen from. They are the same from
every project, so an agent can store one and pass it to `show --id` later. A row key stays the
same when a plugin updates; a copy's id holds the plugin's install folder, which changes. A
hook's id holds its place in its file (`#<group>.<index>`), which moves when hooks above it are
added or removed. In a linked worktree, the main checkout's Codex hooks are the worktree's rows:
their id holds the worktree's path, with `main:` before the place, as in
`hook:codex:project:<worktree>:Stop#main:0.0`.

`--id`, and a name given as an id, take a row key or the id of any copy. For `show`, a copy's
id picks its whole row. A change takes that copy alone, so `csn mcp rm --id` with one account's
copy leaves the other accounts' copies as they are.

### Output, errors and exit codes

Text and JSON go to stdout. Without `--json`, an error goes to stderr as one plain-text line or
block. With `--json`, every error is one JSON object on stdout, and stderr stays empty. Its
`error` names the kind of error; [Errors](#errors) lists them.

| Code | When |
|---|---|
| 0 | Done, or nothing to do |
| 1 | Not found, refused, changed since it was read, locked, conflict, failed, or nothing to undo |
| 2 | Bad usage, an unknown option or command, an ambiguous name, or a change without --yes where it can't ask: no terminal, or --json |

A dry run exits 0, even when it lists rows that can't change. So does a change with nothing to
do, and a question answered no.

A name nothing has prints `No skill named 'nope'.` and exits 1. When `--tool`, `--scope` or
`--account` narrowed the search, it adds "Leave out --tool, --scope or --account to look
further."

When a file cannot be read, the text output ends with "Could not read every file, so this
list may miss what they hold:" and each file, with a position or a reason and never what it
holds. JSON lists them in `warnings`. The exit code stays 0.

A Codex `config.toml` that Codex refuses is one of them, and clausona reads none of it. Codex
refuses one that is not valid TOML, one with an integer too large for 64 bits (a larger one that
fits reads as Codex reads it), and one with a value of the wrong type in its typed config. Then
Codex loads none of its config, and no skill, server, hook or plugin either, so every Codex row
is off: Loaded says "off everywhere (Codex cannot read ~/.codex/config.toml)". clausona checks
the sections it reads, against Codex's types:

- `mcp_servers`: a server's fields, and its transport (a `command` or else a `url`, with nothing
  the other takes);
- `[[skills.config]]`: each entry's `enabled`, `name` and `path`;
- `hooks` and `[hooks.state]`;
- `plugins` and their servers' `enabled`;
- `projects` and each `trust_level` (`trusted` or `untrusted`, as written).

A trusted project's `config.toml` is checked merged over yours, as Codex merges them. So a
switch for a server you do not define is a server with no transport, which Codex refuses too.
When Codex refuses a trusted project's file, it loads no config in that project, yours
included: the warning says so, and every Codex row is off in that project ("off here (Codex
cannot read this project's .codex/config.toml)"). An untrusted project's file Codex leaves alone,
one that is not valid TOML too. clausona does not check the
sections it does not read. A wrong type there makes Codex refuse the file all the same, and
clausona reads the file as fine.

## Changing things

`off` and `on` turn a row off or back on, `visibility` sets how much of a Claude skill Claude
Code shows, and `rm` deletes. Each takes one or more names, or `--id`s from `ls --json`. A name
is looked up the way `show` looks (see [show](#show)), so `csn skills rm eli5` takes the copy
that loads here, and `--scope`, `--tool` or `--id` picks another. A name that several rows have
is ambiguous and exits 2, as with `show`.

A change is planned first and shown, and made only once you agree. Every file it touches is
backed up first, and `undo` puts the change back. On the screen the same changes are keys, see
[Changing things from the screen](#changing-things-from-the-screen).

### Off and on

Here is the project everything is seen from: the current one, or `--project`. Everywhere is
every project, through your user settings for Claude Code and through Codex's own
`config.toml`. Without `--everywhere`, `off` and `on` work here. On the screen `space` is here
and `g` is everywhere. [What each change writes](#what-each-change-writes) has the key and the
file for each tool and kind.

`on` takes back what `off` wrote at the same level. It removes the value, or writes the row on
there where removing it would leave a value below that still turns it off. For a plugin, `on`
always writes `true`. When a switch in one project's own place still turns the row off there,
`on --everywhere` says so in a note naming the switch, its file and any account, such as
`Still off in this project (skillOverrides.eli5 in ~/app/.claude/settings.local.json). Turn it on here too.`
That is a project's settings for a skill or a plugin, an account's entry for the project in its
`.claude.json` for a server, and for Codex a project skill's path entry or the project's
`config.toml`.

Some rows can only be switched one way:

- Codex turns a user skill off everywhere or nowhere, so off here is refused for it.
- Claude Code turns a `.mcp.json` server on or off per project, so everywhere is refused for it.
  One of a folder that is no project, seen from a project outside that folder, is `not here`:
  it loads in each project below the folder, with that project's approvals, so off and on are
  refused for it too. Run them in one of those projects, or pass `--project`.
- A plugin installed for one project can't be switched everywhere.
- Codex reads a project's `.codex` folder only in a project it trusts, so a change there, such
  as a Codex MCP server off here, is refused in any other project. In the home folder that
  folder is your user config, so use `--everywhere` there.
- What a plugin brings is turned on and off with the plugin. Switch the plugin itself, with
  `--scope plugins`: `csn skills off kit@demo --scope plugins`. A plugin's MCP server has a
  switch of its own here, in each account, so `mcp off` works on one in this project.
- Codex's plugins, and what they bring, are switched in Codex, with `/plugins`. clausona lists
  them and changes none of them.
- Turning on what a setting elsewhere keeps off would change nothing, so `on` is refused, and
  the reason names the setting and its file: a Claude server that `deniedMcpServers` keeps out
  (`mcp-denied`), that `allowedMcpServers` leaves out (`mcp-not-allowed`) or that
  `managed-mcp.json` shuts out (`managed-mcp`), and a built-in skill while
  `disableBundledSkills` holds (`bundled-off`, for `visibility` too). A list or setting in
  managed settings is refused as `managed`, as anything there is. One in this project's own
  settings holds here alone, so `on --everywhere` goes ahead, with a note such as
  `Still off in this project: deniedMcpServers in …`. `off` is never refused for it.
  A `serverCommand` or `serverUrl` entry can keep out one account's copy of a server and not
  another's, when the accounts define the server differently. Then `on` turns on the copies
  that can start and leaves the others as they are, each with a note that names its account
  and the list, such as
  `Stays off for work: deniedMcpServers in ~/.claude/settings.json keeps it from starting.`
  It leaves them out as it leaves out an account that has not opened the project, and is
  refused only when no copy it takes can start.

[Refusals](#refusals) has every reason a change can't be made, in the words the CLI and the
screen use.

A Claude MCP server that accounts hold in their `.claude.json`, a user server or a local one, is
switched in each account's entry for the project: `projects[<project>].disabledMcpServers`, the
list `/mcp disable` writes. A plugin's server is switched the same way. Claude Code makes that
entry the first time an account opens the project, and clausona never makes one. So off here
changes only the accounts that have opened the project, and leaves out the others with a note,
`work has not opened this project`. When no account that has the server has opened the project,
the change is refused.

`--account <name>`, once or more, changes those accounts only. Without it, every account that
has the server changes. On the screen the dialog lists the accounts to pick from.

Off everywhere takes the server out of each account's `.claude.json`. clausona keeps the entry
it took out, so that `on --everywhere` can put it back where it was. `on --everywhere` leaves an
account's switch in this project as it is, whether it puts an entry back or finds none kept.
When one still turns the server off here, the plan says so in a note,
`Still off in this project for work (disabledMcpServers in ~/.claude-work/.claude.json). Turn it on here too.`

Neither Claude Code nor Codex has a switch for one hook in one project. So `hooks off` and
`hooks on` always work everywhere: off takes the hook out of its settings file and clausona
keeps it, and on puts it back. `--everywhere` is taken and changes nothing. On the screen `g`
turns a hook off, and `space` says why it can't.

While `disableAllHooks` keeps every Claude hook off, turning one on would not make it run, so
`on` is refused, as `all-hooks-off`, and the reason names the file that sets it. Set in managed
settings, it is refused as `managed`, as anything there is. When this project's own settings
set it, it holds in this project only, so `on` goes ahead and the plan says
`Still off in this project: disableAllHooks in …`.

A server or a hook taken out and kept by clausona still has its row, in its own scope and in
`--scope all`, with the tag `off`. It is not in Loaded, since it does not load. For a server the
details read `off everywhere (kept by clausona)`. For a hook they read `off everywhere — clausona
keeps its settings so you can turn it back on`. A server keeps its id. A hook's id changes to
`hook:<tool>:<scope>:stash-<id>:<name>`. Read ids again from `ls --json` before you pass one to
`on`.

`on --everywhere`, or `g` on the screen, puts it back. If a server of that name, or the same
hook, is back in that place by then, the change stops with a conflict and clausona keeps its
copy. `rm` deletes the copy clausona kept: it goes into the backup like any other file.

### What each change writes

A path with no `~`, such as `.claude/settings.local.json`, is in the project. `~/.claude` is
the primary Claude Code folder, and Codex's home is `~/.codex` by default, as under
[Scopes](#scopes).

| Tool, kind | Off here | Off everywhere | Delete |
|---|---|---|---|
| Claude skills | `skillOverrides.<name>` set to `"off"` in `.claude/settings.local.json` | `skillOverrides.<name>` set to `"off"` in `~/.claude/settings.json` | The folder moves into the backup. A link is removed and its target kept. A legacy command's `.md` file moves into the backup. |
| Claude plugins | `enabledPlugins.<id>` set to `false` in `.claude/settings.local.json` | `enabledPlugins.<id>` set to `false` in `~/.claude/settings.json` | Refused: `/plugin` in Claude Code uninstalls a plugin. |
| Claude MCP, user and local servers | The name added to `projects[<project>].disabledMcpServers` in each account's `.claude.json` | Taken out of each account's `.claude.json` and kept by clausona | `mcpServers.<name>` deleted from each account's `.claude.json`, or from the project's entry there for a local server |
| Claude MCP, `.mcp.json` servers | The name added to `disabledMcpjsonServers` and taken out of `enabledMcpjsonServers`, in `.claude/settings.local.json` | Refused | `mcpServers.<name>` deleted from that `.mcp.json` |
| Claude MCP, a plugin's servers | As for a user server | Refused: switch the plugin | Refused: it goes with the plugin |
| Claude hooks | Refused: hooks are switched everywhere | Taken out of its settings file and kept by clausona | Deleted from its settings file |
| Codex skills | A project skill: a `[[skills.config]]` entry with the `path` of its `SKILL.md` and `enabled = false`, in Codex's `config.toml`. A user skill: refused | A `[[skills.config]]` entry with its `name` and `enabled = false`, in Codex's `config.toml` | As for Claude skills. A built-in skill is refused. |
| Codex MCP | `mcp_servers.<name>.enabled = false` in the project's `.codex/config.toml` | A user server: `mcp_servers.<name>.enabled = false` in Codex's `config.toml`. A project server: refused | `[mcp_servers.<name>]` deleted from the `config.toml` that defines it |
| Codex hooks | Refused: hooks are switched everywhere | Taken out of its `hooks.json` and kept by clausona. One in a `config.toml`: refused | Deleted from its `hooks.json`. One in a `config.toml`: refused |
| Codex plugins, and what they bring | Refused: `/plugins` in Codex switches a plugin | Refused | Refused: `/plugins` in Codex uninstalls a plugin |

`.claude/settings.local.json` is the project's own Claude Code settings, the ones not shared
with the repo. When a change needs a file that is not there yet, such as a project's first
`.claude/settings.local.json`, it makes the file, and the plan says `create`.

Claude Code keeps that file out of git. When it makes one, it adds
`**/.claude/settings.local.json` to git's global ignore file, and clausona does the same. When a
change makes a project's first `.claude/settings.local.json` in a git repository that does not
ignore it yet, the plan has one more line:
`~/.config/git/ignore  adds **/.claude/settings.local.json  as Claude Code does`. The file is the
one `core.excludesFile` names in your global git config, else `$XDG_CONFIG_HOME/git/ignore`,
else `~/.config/git/ignore`, and it is made when it is not there. It is backed up like any other
file. Without git, outside a repository, or with the line in that file already, there is no such
line.

Undo leaves the line in, as Claude Code does. Claude Code never takes it out, and a
`settings.local.json` it made since, in another repository, may rely on it: Claude Code adds no
ignore rule for a file git ignores already. Undo still takes back the `settings.local.json` the
change made, and says where it lists what it puts back that the line stays:
`~/.config/git/ignore  keeps **/.claude/settings.local.json, as Claude Code does`.

`on` writes in the same places. For a `.mcp.json` server it also takes the name out of
`disabledMcpjsonServers` in each account's entry for the project, where an account turned it
down. Adding the name to `enabledMcpjsonServers` approves a command the repo defines, so that
line of the plan says what the server runs, its command or URL with secrets hidden as the
details hide them, as in `runs npx docs-mcp --api-key <hidden>`. A server approved before has
nothing new to approve, and its plan says nothing of it. A server turned off in your user settings or in the project's shared
`.claude/settings.json` stays off whatever is written here, so `on` is refused and the reason
names that file. `visibility` writes `skillOverrides.<name>` as off does, with the level as the
value.

A Codex project skill's `[[skills.config]]` entry names its `SKILL.md` by a path, and Codex
takes any path that leads there, through a link or not: Codex's own UI writes the real one. So
off and on here change every entry that names the skill, by whichever path, and add one, with
the path the skill is listed at, only when none does.

A JSON file keeps its indent, key order, line endings and last newline. A TOML file is changed
line by line, so its comments stay, and the result is read back and checked before it is saved.

### Visibility

A Claude skill has four levels, the values of `skillOverrides` that Claude Code reads:

| Level | Claude Code shows the skill |
|---|---|
| `on` | as the full skill |
| `name-only` | as its name only |
| `user-invocable-only` | only when you call it |
| `off` | not at all: it is off |

`csn skills visibility eli5 name-only` sets it in this project, in
`.claude/settings.local.json`. With `--everywhere` it goes in your user settings,
`~/.claude/settings.json`. `on` shows the full skill again: it takes this level's value out, or
writes `on` where a value below would still hold the skill back. `off` is the same as
`csn skills off`.

Only Claude skills have levels, so `visibility` looks at Claude's skills alone and takes no
`--tool`. On the screen, `v` in a Claude skill's details moves it to the next level, in this
project: full skill, name only, only when you call it, off, then the full skill again.

### Delete

`rm` deletes the thing a row names, wherever the row has a copy of it: a skill's folder, a
server's entry in each account's `.claude.json`, a hook's entry in its settings file.
`--account` keeps it to some accounts.

A skill's folder moves into the backup, so `undo` can move it back. A folder reached through a
linked folder above it is deleted at its real path, and the plan names that path,
`the folder at ~/dotfiles/skills/eli5`. A skill that is itself a link is unlinked. The link goes
and what it leads to stays, and the plan says `link only, target kept`. A broken link is removed
the same way.

A link can make one folder two rows. With `~/.claude/skills` linked to `~/.agents/skills`, each
skill there is a Claude row and a Codex row, and deleting one would delete the other's folder
too. So it is refused unless both rows are in the same `rm`, as in
`csn skills rm --id '<id>' --id '<other id>'`, or both are marked with `x` on the screen. Then
the folder moves once.

A folder can also hold what other skill links lead to. gstack, cloned into
`.claude/skills/gstack`, links each skill it holds in next to it, as `.claude/skills/canary`
leading to `gstack/canary`. Deleting `gstack` alone leaves those links broken, so the plan says
so next to the folder, `breaks 30 links: canary, careful, freeze, … (add them to delete them too)`.
It is not refused: undo puts the folder back, and the links work again. Add the links to the
same `rm`, or mark them too on the screen, and the note goes.

Codex finds skills in folders below a skill too, so a Codex skill's folder can hold other Codex
skills, as `~/.agents/skills/pack` holds `pack/inner` and `pack/inner/deeper`. Deleting `pack`
deletes them with it, and the plan says so next to the folder,
`also deletes 2 skills inside: deeper, inner`. Add them to the same `rm`, or mark them too on the
screen, and the note goes: the outer folder moves once, on one line for every row it takes, and
undo puts them all back.

A file or folder that git tracks in a project changes the repo when it changes. The CLI refuses
such a change unless you add `--tracked`, for `off`, `on` and `visibility` as well as `rm`.
What is in your home folder and in no project counts as not tracked, even when the home folder
is a repository. A folder inside the project that is a repository of its own, such as a skills
pack or a whole `.claude/skills` cloned into place, counts as tracked, and so does what is in it,
only when the project's repository holds that folder as a submodule: its files belong to the
clone, not to the project.

On the screen, `d` on what git tracks opens the dialog with a warning,
`Git tracks deploy-check in app, so deleting changes the repo.` It offers `o` to turn it off
here instead, `y` to delete it anyway, and `n`. The other keys mark such a line
`changes the repo`, and the dialog is your consent. When git is not there or fails, the file
counts as not tracked, and the change is backed up all the same.

When git does not answer within 10 seconds, as on a very busy machine, the file counts as
tracked, since it may be: the change needs `--tracked`, or the dialog's consent, all the same.
The refusal and the warning say that git did not answer in time, and a line it goes ahead with
says `may change the repo (git did not answer in time)`. Run it again to ask git once more.
A project's first `settings.local.json` still gets its ignore line when git did say in time that
it would not ignore the file.

Some things can't be deleted here:

- A Cloud skill comes back from claude.ai. Turn it off instead.
- A built-in skill comes with the tool. Turn it off instead.
- A plugin is uninstalled with `/plugin` in Claude Code, or `/plugins` in Codex, and what it
  brings goes with it.
- What your organization's managed settings set stays as they set it. clausona changes nothing
  managed.

### Confirm, backups and undo

Before anything changes, the plan is shown: a question, a line per file with what changes in
it, what is already as asked, what can't change and why, and where the backup goes. The CLI
prints it and asks, no by default. The screen shows it in a dialog.

```
$ csn skills rm old-one notes
  Delete 2 skills?

      ~/.claude/skills/old-one
      ~/.claude/skills/notes    link only, target kept

  Backup: ~/.clausona/backups/extensions/
  Run clausona skills undo afterwards to put them back.
  Apply? (y/N) y
  ✔ Deleted 2 skills
    Backup: ~/.clausona/backups/extensions/20261010T043648123Z-skills-rm
    Undo: clausona skills undo
```

Answering no prints `Cancelled. Nothing changed.` and exits 0.

`--yes`, or `-y`, goes ahead without asking. Where there is no terminal to ask on, as when a
script or an agent runs it, a change without `--yes` is bad usage and exits 2:
`This changes files, and there is no terminal to confirm on. Add --yes to go ahead, or --dry-run to see the plan.`
With `--json` it needs `--yes` on a terminal too, so that stdout stays one JSON object:
`With --json, add --yes to go ahead, or --dry-run to see the plan.`

`--dry-run` prints the plan, as JSON with `--json`, and changes nothing, not even
`~/.clausona`. It exits 0. The text ends
`Dry run: nothing changed. Run it again with --yes to apply.`, or, when some rows can't change,
says to leave them out first.

In the CLI a change is all or nothing. When any row it names can't change, nothing changes: it
exits 1 and lists each row with its reason, after `Nothing changed: 1 of 2 can't be deleted.`
The screen changes the rows that can, and the dialog lists the others.

Before it writes, clausona copies each file it will change into
`~/.clausona/backups/extensions/<id>/`, with a `manifest.json` that says what changed. A deleted
folder or file is moved there. The id is the time and the change, as in
`20261010T043648123Z-skills-rm`. clausona keeps the last 50 changes and removes the backups of
older ones.

The backup folders are 0700 and their files 0600, so only you can read them. A copy of
`.claude.json` or of a settings file can hold MCP secrets.

A folder on another disk than `~/.clausona` can't be moved there in one step, so clausona copies
it into the backup and then removes it. Meanwhile it waits in the folder above the skills folder
it was read from, by that folder's real path, such as `~/.agents` for `~/.agents/skills/group/foo`,
under a name that starts with `.clausona-`, where neither Claude Code nor Codex loads it as a
skill. The manifest says where. `undo` moving a folder back across disks makes its copy there
too, and renames it into place once it is whole.

That folder can be on another disk than the skill, as when the skills folder is a disk of its
own, or it can't be written. Then there is no such place. The folder stays where it is, loading
as it did, while it is copied into the backup, and only once the copy is whole is it renamed
next to itself, under a `.clausona-` name, and removed. Should that removal be cut short, what is
left of it waits there, where Claude Code can see it, until the next change or `undo` removes it.
`undo` in that case makes its copy next to where the folder goes, under such a name, where Claude
Code can see it until it is renamed into place.

When the change is cut short, as when the process is killed, the next change or `undo` puts it
right: before the copy is whole, the folder goes back where it was, as if the change had not
started; once the copy is whole, the change is finished, and `undo` puts the folder back from
the backup.

`.claude.json` is changed only under Claude Code's own lock, `.claude.json.lock` next to it, so
clausona never writes it while Claude Code does. When the lock is not free within 15 seconds,
the change stops: `Claude Code is saving ~/.claude.json. Try again in a moment.`

Just before it writes a file, clausona reads it again and checks that what the plan changes is
still as it was read. When something else changed it meanwhile, the change stops there:
`~/.claude.json changed since it was read. Run the command again.` What it did before the stop
is kept as one change, which `undo` puts back. Each file is written to a temporary file next to
it, then renamed over it, so a file is never left half written.

`csn skills undo` puts back the newest skills change not undone yet. `mcp undo` and `hooks undo`
do the same for theirs. Run it again to go one change further back. On the screen, `u` takes
the newest change of any kind. Undo shows what it will put back and asks too, and it takes
`--yes`, `--dry-run` and `--json`.

```
$ csn skills undo --dry-run
  Undo: Deleted 2 skills?

      ~/.claude/skills/old-one  put back
      ~/.claude/skills/notes    put back

  Puts back what changed, unless it changed since.

  Dry run: nothing changed. Run it again with --yes to undo it.
```

Undo puts back only what still holds what the change wrote. A file that something else changed
since is left alone, and undo says so next to its path: `changed since`. When some files go back
and others don't, it starts `Undid part of it:`, lists each file, and exits 1. When none goes
back, it starts `Could not undo:`.

For a JSON file, undo looks at each key the change wrote, not at the whole file. Claude Code
rewrites `.claude.json` all the time, and the rest of the file can change without getting in the
way. A TOML file, a folder or a link goes back only when it is as the change left it.

A file left alone because Claude Code is saving it reads `Claude Code is saving it`. That change
stays the next undo's, so running undo again in a moment finishes it.

Undo never names the copies clausona kept by their path. It calls one `the copy clausona kept`,
and it goes back, or stays, with the file it came from.

Those copies are files in `~/.clausona/extensions/stash/`, one per entry, 0600 like the backups.
clausona reads them to list what it took out, so leave them to it: `rm` and `on --everywhere`
deal with them.

### Refusals

When a row can't change, the plan says why. The screen's words name keys and the CLI's name
options. With `--json`, `refused[].code` is the code below and `refused[].reason` the reason in
the CLI's words. In the table `<tool>` is the tool's name and `<scope>` a scope's label.

| Code | Says | On the screen | In the CLI |
|---|---|---|---|
| `plugin-item` | It comes with the plugin `<plugin>`. | Claude: Turn the plugin on or off in Plugins. Codex: Turn the plugin on or off with `/plugins` in Codex. | Claude: Turn the plugin on or off: `clausona <command> off <plugin> --scope plugins`. Codex: Turn the plugin on or off with `/plugins` in Codex. |
| `cloud-delete` | It comes back from claude.ai. | Press `space` to turn it off instead. | Turn it off instead: `clausona skills off <name>`. |
| `builtin-delete` | It comes with `<tool>`. | Claude: Press `space` to turn it off instead. Codex: Press `g` to turn it off instead. | Claude: Turn it off instead: `clausona skills off <name>`. Codex: Turn it off instead: `clausona skills off <name> --everywhere`. |
| `plugin-delete` | Use `/plugin` in Claude Code to uninstall a plugin. | | |
| `codex-plugin` | Use `/plugins` in Codex to turn a plugin on or off, or to uninstall it. | | |
| `plugin-project-everywhere` | It is installed for this project only. | Press `space`. | Leave out `--everywhere`. |
| `hook-here` | `<tool>` has no per-project switch for hooks. | Press `g` to turn it off everywhere. | |
| `managed` | It is set by your organization's policy. | | |
| `codex-user-here` | Codex turns a user skill off everywhere or nowhere. | Press `g`. | Add `--everywhere`. |
| `codex-untrusted` | Codex does not trust this project, so it ignores its `.codex` folder. | Trust the project in Codex first. | Trust the project in Codex first. |
| `codex-project-everywhere` | It is defined in this project only. | Press `space`. | Leave out `--everywhere`. |
| `codex-home-here` | In your home folder, Codex's project config is your user config. | Press `g`. | Add `--everywhere`. |
| `mcpjson-everywhere` | Claude Code turns a `.mcp.json` server on or off per project. | Press `space`. | Leave out `--everywhere`. |
| `not-here` | It loads in the projects in `<folder>`, each with its own approvals. | Pick one of them with `p`. | Run it in one of them, or pass `--project <path>`. |
| `broken-link` | Its link leads nowhere. | Press `d` to remove the link. | Remove the link: `clausona skills rm <name>`. |
| `no-visibility` | Only a Claude skill has visibility levels. | | |
| `no-project` | There is no project to change it in. | Pick one with `p`. | Run it in a project, or pass `--project <path>`. |
| `stashed-here` | It is off everywhere. | Press `g` to turn it back on. | Turn it back on with `--everywhere`. |
| `stash-gone` | `<file>`, where it came from, is gone. | Press `d` to delete the copy clausona kept. | Delete the copy clausona kept: `clausona <command> rm --id <id>`. |
| `unreadable` | `<file>` could not be read. | Fix it, then try again. | Fix it, then try again. |
| `one-folder` | It is the same folder as `<tool> › <scope> <name>`, through a link. | Mark both with `x` and delete them together. | Delete both together: `clausona skills rm --id <id> --id <other id>`. |
| `tracked` | Git tracks it in `<project>`, so this changes the repo. | Press `o` to turn it off here instead, or `y` to go ahead. | Add `--tracked` to go ahead, or turn it off: `clausona <command> off <name>`. |
| `no-account` | No account that has it has opened this project. | | |
| `elsewhere` | It is turned off in `<file>`, which applies here. | Change it there. | Change it there. |
| `all-hooks-off` | `disableAllHooks` in `<file>` turns every hook off. | Change it there. | Change it there. |
| `mcp-denied` | `deniedMcpServers` in `<file>` keeps it from starting. | Change it there. | Change it there. |
| `mcp-not-allowed` | `allowedMcpServers` in `<file>` leaves it out. | Change it there. | Change it there. |
| `managed-mcp` | `<file>` lets only its own servers start. | Only your organization can change that file. | Only your organization can change that file. |
| `bundled-off` | `disableBundledSkills` in `<file>` turns off the skills that come with Claude Code. | Change it there. | Change it there. |
| `codex-config-hook` | It is written in `<file>`, where clausona does not change hooks. | Use `/hooks` in Codex, or edit the file. | Use `/hooks` in Codex, or edit the file. |
| `codex-worktree-hook` | Codex runs the hooks in `<file>` in this worktree. | Change them there. | Change them there. |

On the screen, `stash-gone` on one account's server, in a row other accounts share, says
`Press d and choose only work in the dialog.` instead, since `d` on the row would delete the
other accounts' copies too. Where Claude Code and Codex have recorded no project, `no-project`
says `Run csn in a project.` instead, since `p` has none to pick. Where git did not answer in
time, `tracked` says
`Git did not answer in time whether it tracks it in <project>, so this may change the repo.`
instead, with the same hints: it counts as tracked.

## JSON

`ls --json` prints one object, the envelope. `show --json` prints one item, with `version`
first and `details` last. A change prints its plan or what it did, `undo` what it put back, and
an error an object of its own. All are indented with two spaces. Paths are absolute; the text
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
| `accounts` | string[] | When set: the profile ids of the accounts that have the row, primary first. Set when the row is held, switched or hidden per account, and for a Global Claude skill that some accounts do not load. |
| `state` | string | One of the states above, or `mixed` when the accounts differ. |
| `stateByAccount` | object | When set: profile id to state, for a row read per account. |
| `loadsByAccount` | object | When set, with `stateByAccount`: profile id to `true` when the row loads here for that account, else `false`. |
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

- `state` and `stateByAccount`. A row read per account has `stateByAccount`, each account's own
  state, and `state` is the value they share, or `mixed`. That is a row of copies in accounts'
  own files, a Cloud skill, a plugin and what it brings, and a `.mcp.json` or plugin server in a
  project an account has opened. Every other row has `state` alone, one value for every account:
  what the files that every account reads say. So for a `.mcp.json` server and for a plugin's
  server in a project no account has opened yet, `state` means the same thing, the settings
  files' word: a `.mcp.json` server's approval there, `pending-approval` until one approves it,
  and a plugin's server its plugin's switch. Each account's own switch, in its `.claude.json`
  entry for the project, comes in with `stateByAccount` once the account opens the project.
- `loadsByAccount` is worked out as Loaded is. It is `true` where that account's state is `on`,
  `name-only` or `user-invocable-only`, no other copy of the name wins in that account, and the
  row is no broken link. So it is `false` where the row is off, pending approval or hidden in
  that account, and for every account when the row is another project's. A row is in Loaded
  when it is `true` for one account.
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
  "loadsByAccount": { "claude:personal": true, "claude:work": false },
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

### Plans and results

`off`, `on`, `visibility` and `rm` with `--json` print one object: the plan with `--dry-run`,
or what was done. It has these keys, in this order; a key marked "when set" is left out when it
does not apply.

| Field | Type | Meaning |
|---|---|---|
| `version` | number | `1`. |
| `command` | string | `skills`, `mcp` or `hooks`. |
| `verb` | string | `off`, `on`, `visibility` or `rm`. |
| `everywhere` | boolean | `true` for a change everywhere: `--everywhere`, and every hooks `off` and `on`. `false` for `rm`. |
| `level` | string | When set: for `visibility`, the level asked for. |
| `dryRun` | boolean | `true` with `--dry-run`. |
| `applied` | boolean | When set, which is never in a dry run: `true` once the change is made, `false` when there was nothing to do. |
| `question` | string | The plan's question, such as `Delete old-one?`. Display text. |
| `changes` | object[] | One per file line, below. Empty when nothing changes. |
| `unchanged` | object[] | The rows already as asked, below. |
| `refused` | object[] | The rows that can't change, below. Only a dry run lists any: a change with one exits 1 with the error `refused`. |
| `notes` | string[] | What else to know, such as `work has not opened this project`. Display text. |
| `accounts` | object[] | When set: for a Claude MCP server, each account with a change as `{ profile, chosen }`, `chosen` being whether `--account` took it. |
| `backupRoot` | string | The folder backups go in, `~/.clausona/backups/extensions` in full. |
| `operation` | object | When set: once applied, `{ id, backup }`, the change's id and its backup folder. |

Each of `changes`:

| Field | Type | Meaning |
|---|---|---|
| `file` | string | The file or folder that changes. A deleted folder is named where its row lists it; `note` says when its real path is elsewhere. A copy clausona kept is named by its path here, under `~/.clausona/extensions/stash/`, where the text output says "the copy clausona kept". |
| `change` | string | `edit`, `create` for a file not there yet, `delete` for a folder or file moved into the backup, or `unlink` for a link removed. |
| `what` | string | What changes in it, such as `skillOverrides.eli5 → off`, `disabledMcpServers + github` or `mcpServers.github taken out, kept by clausona`. Empty for a folder or file deleted. Display text. |
| `account` | string or null | The profile id when the file is that account's `.claude.json`, else `null`. |
| `note` | string or null | Such as `link only, target kept`, `changes the repo`, `may change the repo (git did not answer in time)` or `the folder at ~/dotfiles/skills/eli5`. |
| `tracked` | boolean | `true` when git tracks it, or did not answer in time whether it does, and `--tracked` let the change go ahead. |
| `rows` | string[] | The row keys this line is for, as `id` in `ls --json`. |
| `deletes` | string[] | For a folder deleted, the row keys of the other skills inside it that are not in the same `rm`: the skills its move takes along. Empty otherwise. |
| `breaks` | string[] | For a folder deleted, the row keys of the skill links that lead into it and are not in the same `rm`: the links it leaves broken. Empty otherwise. |
| `runs` | string or null | For a line that approves a `.mcp.json` server, what the server runs: its command or URL, with secrets hidden as in an item's `summary`. `null` otherwise. |

Each of `refused`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The row's key. |
| `name` | string | The row's name. |
| `code` | string | Why, as a code from [Refusals](#refusals). Read this one. `all-hooks-off`, `mcp-denied`, `mcp-not-allowed`, `managed-mcp` and `bundled-off` say a setting elsewhere keeps the row off; the reason names it and its file. |
| `reason` | string | The reason and what to do, in the CLI's words. Display text. |

Each of `unchanged`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The row's key. |
| `name` | string | The row's name. |
| `why` | string | Such as `already off in this project` or `already off in work`. Display text. |

`csn skills rm old-one pdf --dry-run --json`, where `pdf` is a Cloud skill:

```json
{
  "version": 1,
  "command": "skills",
  "verb": "rm",
  "everywhere": false,
  "dryRun": true,
  "question": "Delete old-one?",
  "changes": [
    {
      "file": "/home/you/.claude/skills/old-one",
      "change": "delete",
      "what": "",
      "account": null,
      "note": null,
      "tracked": false,
      "rows": ["skill:claude:global:-:old-one"],
      "deletes": [],
      "breaks": [],
      "runs": null
    }
  ],
  "unchanged": [],
  "refused": [
    {
      "id": "skill:claude:synced:-:pdf",
      "name": "pdf",
      "code": "cloud-delete",
      "reason": "It comes back from claude.ai. Turn it off instead: clausona skills off pdf."
    }
  ],
  "notes": [],
  "backupRoot": "/home/you/.clausona/backups/extensions"
}
```

A plan names files, keys and server names. It never holds what a server's or a hook's entry
holds, but for what a `.mcp.json` server runs when the plan approves it, with secrets hidden.

### Undo

`undo --json` prints one object. A dry run has `files`, what undo would do; once it is done,
`restored` and `skipped`.

| Field | Type | Meaning |
|---|---|---|
| `version` | number | `1`. |
| `command` | string | `skills`, `mcp` or `hooks`. |
| `verb` | string | `undo`. |
| `dryRun` | boolean | `true` with `--dry-run`. |
| `operation` | object | The change it undoes: `{ id, summary, createdAt }`. `summary` is what the change said when it was done, such as `Deleted old-one`. |
| `files` | object[] | When set, in a dry run: `{ path, action }` for each file, `action` being `put back`, `remove` or `edit back`. |
| `restored` | string[] | When set, once done: the paths it put back. |
| `skipped` | object[] | When set, once done: `{ file, reason }` for each file it left alone. |
| `kept` | object[] | When set: `{ path, line }` for each file undo leaves as the change made it, and the line that stays: git's global ignore file, with `**/.claude/settings.local.json`, as under [What each change writes](#what-each-change-writes). In a dry run and once done. |

`skipped[].reason` is one of these, with the words the text output puts after the path:

- `changed`: changed since
- `occupied`: something is there again
- `locked`: Claude Code is saving it
- `missing`: is gone
- `failed`: could not be put back

An undo that left a file alone exits 1, and its object is an error: `locked` when Claude Code
was saving every file it left alone, else `changed`. The error has `operation`, `restored` and
`skipped` too. So an undo that exits 0 has `skipped: []`.

The copies clausona kept are left out of `files`, `restored` and `skipped`. Each goes back, or
stays, with the file it came from, which is listed.

### Errors

With `--json`, every error is one object on stdout:

```json
{
  "version": 1,
  "error": "refused",
  "message": "Nothing changed: 1 of 2 can't be deleted.\n    pdf  It comes back from claude.ai. Turn it off instead: clausona skills off pdf.",
  "refused": [
    {
      "id": "skill:claude:synced:-:pdf",
      "name": "pdf",
      "code": "cloud-delete",
      "reason": "It comes back from claude.ai. Turn it off instead: clausona skills off pdf."
    }
  ]
}
```

`error` is one of the kinds below; read it to tell errors apart. `message` is what the command
prints without `--json`, and it can run over several lines. It never quotes what a file holds
or the value of an option.

| Kind | Exit code | When |
|---|---|---|
| `usage` | 2 | Bad usage: an unknown option or subcommand, a value not in its list, an option the subcommand does not take, or a change or an undo without `--yes` where it can't ask. |
| `ambiguous` | 2 | A name matches several rows. See [The ambiguous error](#the-ambiguous-error). |
| `not-found` | 1 | No row has that name or id. |
| `refused` | 1 | A row the change names can't change, so nothing changed. |
| `changed` | 1 | A file changed since it was read, so the change stopped there. Or undo left a file alone. |
| `conflict` | 1 | Something being put back is in its place again. |
| `locked` | 1 | Claude Code was saving `.claude.json` and its lock did not come free in time. Or undo left files alone for that reason only. |
| `failed` | 1 | A file could not be changed, or something else went wrong, such as clausona not set up yet. |
| `nothing-to-undo` | 1 | No change of that command is left to undo. |

Some kinds add keys after `message`:

- `refused` adds `refused`, the rows and their reasons, as in a plan.
- `changed`, `locked`, `conflict` and `failed`, when a change stopped, add `operation`, which is
  `{ id, backup }`; `done` and `total`, how many of its file changes were made; and `file`, the
  file it stopped at. What was made is one change, which `undo` puts back.
- `changed` and `locked` from an undo add `operation`, which is `{ id, summary, createdAt }`,
  `restored` and `skipped`, and `kept` when set, as under [Undo](#undo).
- `ambiguous` adds `name`, the name given, and `candidates`.

### The ambiguous error

With `--json`, a name that matches several rows prints this on stdout and exits 2:

```json
{
  "version": 1,
  "error": "ambiguous",
  "message": "2 skills are named 'eli5':\n    claude  global  —  —  --id 'skill:claude:global:-:eli5'\n    codex   global  —  —  --id 'skill:codex:global:agents:eli5'\n    Pick one with --tool, --scope or --id <id>.",
  "name": "eli5",
  "candidates": [
    { "id": "skill:claude:global:-:eli5", "tool": "claude", "scope": "global", "project": null, "account": null },
    { "id": "skill:codex:global:agents:eli5", "tool": "codex", "scope": "global", "project": null, "account": null }
  ]
}
```

`message` is the text the command prints without `--json`. `name` is the name given, and is
left out when the rows matched an `--id`. Each of `candidates` has `id`, the row's id to pass to
`--id`; `tool`; `scope`; `project`, or `null`; and `account`, the profile id when the row is one
account's single copy, else `null`. They are the candidates of one tier (see [show](#show)).
A change looks a name up the same way, so it prints the same object.

### Versioning

Every JSON output starts with `"version": 1`: the `ls` envelope, the `show` item, a plan, an
undo and every error. Within version 1, keys can be added, and new values can appear in `scope`,
`state`, `tags`, `summary` and `contains`. A key keeps its name, type and meaning. A change
that breaks this comes with `version: 2`.

`from` and `details` are display text, written for people: their wording can change within
version 1. So are a plan's `question`, `what`, `why`, `reason` and `notes`, and an error's
`message`. Read `scope` for where a row lives, `tags` for what holds it back, `code` for why a
row can't change and `error` for what went wrong.

So check `version`, read keys by name, and skip the ones you do not know.

## Safety

`ls` and `show` only read, and so does the screen until you answer `y` in its dialog. They
never write, lock or move a file of Claude Code or Codex, and they keep no cache: each run
reads the files as they are.

The changes go through the confirm step and the backup in
[Confirm, backups and undo](#confirm-backups-and-undo). Nothing is written before you agree, or
pass `--yes`, and every file is backed up before it is written.

Secret values stay out of every output, the screen, the text and `--json`, plans included:

- An MCP server's env and header values are never copied out of its config. Only their names
  are shown, such as `GITHUB_TOKEN (value hidden)`.
- In a command line, a URL or a hook's command, a value that looks like a secret reads
  `<hidden>`, such as the word after `--api-key` or a token in a URL. Telling a secret from an
  option is a heuristic, and it leans toward hiding. One shape still shows: a secret spelled like
  a secret option, such as `--mytoken`, after a secret flag and before a plain word
  (`--password --mytoken serve`), which reads the same as `--auth --api-key K`.
- A warning about a file names the file and a position in it, never what the file holds.
- A plan or an error names files, keys and server names, never what a server's or a hook's
  entry holds.

The backups, and the copies clausona keeps of what it took out, do hold whole entries, secrets
included. Their folders are 0700 and their files 0600, so only you can read them, and nothing
prints them.

Nothing leaves the machine. Listing and changing make no network call.

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
from. For a Claude MCP server, `loadsByAccount` says which accounts load it, and the tag
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
csn mcp show github --tool claude --json | jq '{accounts, state, stateByAccount, loadsByAccount}'
```

`--tool claude` is there because accounts are Claude's. Without it, a Codex server with the
same name makes `show` find two servers, exit 2 and ask which one.

`accounts` lists the profile ids that have the server; an account not in it does not have it.
`stateByAccount` gives each one's state in this project: `on`, `off` or `pending-approval`.
It is each account's switch: where another copy of the name wins in an account, it still reads
that account's switch, and that account's line in `details` says the copy is hidden, as in
`hidden by the Project copy`. `loadsByAccount` answers "does it load for `work` here?" for
each account, `true` or `false`, with the switch and the copy that wins both counted.

A Codex server has no `accounts`, because Codex has no accounts here; its `state` is the one
state. A `.mcp.json` server in a project no account has opened has none either, and its `state`
is what the settings files approve, as for any row read once for every account (see
[Item fields](#item-fields)).

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

### Remove unused global skills

```bash
csn skills ls --scope unused --tool claude --json \
  | jq -r '.items[] | select(.scope == "global") | .id'
csn skills rm --id '<id>' --id '<id>' --dry-run --json
csn skills rm --id '<id>' --id '<id>' --yes
csn skills undo --yes        # if it was a mistake
```

Pass each id from the first command to `--id`. `--yes` is there because an agent has no
terminal to answer on; without it the change exits 2 and changes nothing.

Read the dry run before the real one. `refused` lists what can't go, each with a `code`. For
global skills that is most likely `one-folder`: a skill whose folder another row shares through
a link, such as the Codex row of a skills folder linked to `~/.agents/skills`. A change with any
refused row changes nothing, so leave those ids out, or add the other row's id. In `changes`, a
line whose `note` reads `link only, target kept` is a skill that is a link, a broken one
included: the link goes and the folder it leads to stays.

`csn skills undo --yes` puts back the newest skills change, which is this one if nothing came
after it.

### Turn one MCP server off for one account here

```bash
csn mcp off github --tool claude --account work --dry-run
csn mcp off github --tool claude --account work --yes
csn mcp show github --tool claude --json | jq '.stateByAccount'
```

The dry run's `changes` has one line, in work's `.claude.json`, with `what`
`disabledMcpServers + github`. When work has not opened this project, the dry run lists github
in `refused` with the code `no-account` instead, since clausona never makes the project's entry
in an account's `.claude.json`. Afterwards `stateByAccount` reads `off` for `claude:work`, and
the other accounts are as they were.

### Turn a hook off everywhere and back on

```bash
csn hooks ls --json | jq '.items[] | {id, name, command: .summary.command}'
csn hooks off --id '<id>' --yes
csn hooks ls --scope all --json | jq '.items[] | select(.state == "off") | {id, name}'
csn hooks on --id '<new id>' --yes
```

Off takes the hook out of its settings file, in every project, and clausona keeps it. It no
longer runs, so it leaves Loaded, the default scope; `--scope all` and its own scope still list
it, with the state `off` and a new id. `on` takes that new id and puts the hook back.
It goes into its old group if the group is still there with the same matcher. Else it joins
another group with that matcher, or gets a new group at the end of the event.

A hook's id holds its place in its file, so taking one out moves the ids of the hooks after it
on the same event. Read the ids again before the next change.

## On the screen

Run `csn` and choose Extensions. Claude and Codex are tabs, and Skills, MCP and Hooks are the
second level. The scope list is on the left and the chosen scope's table on the right. At 100
columns or more both show; below that, one at a time: scopes, then the table, then the
details.

The scope list's first line is the project row, and it is Loaded. It names the project
everything is seen from and counts what loads there, such as `▸ app (here)  118`. `(here)`
marks the project of the folder you started `csn` in. Under the row, after a rule, the scopes
say where those rows come from. They also list what does not load: a copy another one hides, an
item turned off, a plugin as one row.

At the filesystem root, where there is no project, the row reads `No project` and the title bar
`No project — pick one with p`. Where Claude Code and Codex have recorded no project either,
there is none to pick: the title bar reads `No project`, and what needs a project says to run
`csn` in one.

`p` opens the project list in the scope list's place. The heading reads `PROJECT` with the
kind on the right: `skills`, `MCP servers` or `hooks`. The project you are looking from comes
first. Every other project that Claude Code or Codex recorded follows, by name, with the count
of its own rows of this tool and kind, the ones its Project scope lists. A project with none
shows `—`. When two projects have the same folder name, the folder above is shown too, as in
`work/site`. The list has no `No project` line: Global and the other scopes under the project
row already list what loads outside any project, whichever project is picked.

Type to narrow the list. What you type matches a project's name or its path, in any case, and
the heading shows it in `PROJECT`'s place, as `/clau▏`. `esc` clears it, and a second `esc`
closes the list. `pgup` and `pgdn` move a page, and `home` and `end` go to the first and the
last project. On a Mac keyboard those are `fn` with `↑`, `↓`, `←` and `→`. Terminal.app keeps
them for scrolling its own window, so add `shift` there.

While the list is open, the table beside it shows the own rows of the project under the
cursor, the ones the list counts: its Project table. `enter` picks that project and keeps the
table: every scope is then seen from it, and the title bar and the table's header name it.
Loaded is one `↑` away, on the project row. `esc` or `←` closes the list and changes nothing.

The screen's tables differ a little from the CLI's. They have no TOOL column, and Codex skills
show their description. Loaded groups its rows by the place each comes from, in the scope
list's order, under a heading that names the place and counts its rows: `Project 1`, then
`Global 7`, and so on. Its FROM column says only what a heading does not, the plugin a row
comes from or the `.mcp.json` above the project, and is left out when no row has that.

### Keys

| Key | What it does |
|---|---|
| `tab` | Switch between Claude and Codex, back to the project row. |
| `1` `2` `3` | Skills, MCP, Hooks, back to the project row. |
| `↑` `↓` `pgup` `pgdn` | Move. In the project list, `home` and `end` too. |
| `→` or `enter` | From the scope list into the table. On the project row, Loaded's table. |
| `enter` | On a row, its details. In the project list, look from that project. |
| `←` or `esc` | Back one step. `esc` on the scope list leaves the screen. In the project list, `esc` clears what you typed, then closes it; `←` closes it. |
| `/` | Search the table. `enter` keeps the search, `esc` drops it. |
| `p` | Open the project list, from anywhere but a search. Type there to narrow it. |
| `m` | A matrix of servers by account: which account starts which server in this project. On Claude's MCP tab, with a project picked. In it, `↑` `↓` move from server to server and `←` `→` from account to account. |
| `r` | Read the files again. |
| `w` | The files that could not be read, when there are any. |
| `space` | Turn the marked rows, or the row under the cursor, off or on here. In the details, the row shown. In the matrix, the server under the cursor, for its account only. |
| `g` | Turn the same rows off or on everywhere. |
| `d` | Delete the same rows. |
| `x` | In the table, mark the row, or unmark it. `esc` in the table clears the marks before it goes back. |
| `u` | Undo the newest change, of any kind. From the scopes, the table, the details or the matrix. |
| `v` | In a Claude skill's details, move it to its next visibility, in this project. |

Search matches a row's name, description, file, summary values, and the text cells the table
shows. It does not match the numbers in USES and LAST USED.

### Changing things from the screen

`space`, `g` and `d` act on the marked rows when there are any, else on the row under the
cursor. The table's header counts the marks, as in `13 · 2 marked`. Marks clear when the table
changes, by `tab`, `1` `2` `3`, another scope or another project, and after a change is made.
In the scope list these keys say `Open the table first: →`. `v` outside a Claude skill's
details says `v changes a Claude skill's visibility, in its details.`

A row's details end with what the keys would do to it, such as
`space off here · g off everywhere · d delete · v name only`. A key that would be refused is
left out.

`space` turns a row on when it is off here, or is a `.mcp.json` server pending approval, and off
otherwise. It reads the row's switch, not whether the row loads: a copy another one hides, or a
Codex skill Codex skips for `no front matter`, is turned off. A `.mcp.json` server pending
approval does not run, so `space` turns it on, which approves it, and its details say
`space on here`. To turn one down instead, use `csn mcp off <name>`.

When the row can't change, nothing opens, and the status line says why, in keys:
`It comes back from claude.ai. Press space to turn it off instead.` When none of the marked rows
can, it says how many can't and why the first one can't. When there is nothing to do, it says
that: `Nothing to do: already off in this project.`

Otherwise a dialog takes the panes' place, before anything changes. It has the question, such as
`Turn off eli5 in this project?`, then a line per file with what changes in it, the rows that
can't change and why, the backup folder, and `Press u afterwards to put them back.` Under the
line that approves a `.mcp.json` server is what it runs, whole. `y` makes
the change, `n` or `esc` closes it and changes nothing, and `pgup` and `pgdn` scroll its lines.

For a Claude MCP server that several accounts have, the dialog lists the accounts, each `◉`
when it is picked and `○` when not. `↑` and `↓` move, and `space` picks an account or leaves it
out. The question follows, as in `Turn off figma in this project, for personal?`. `y` with no
account picked says `Pick at least one account.` and the dialog stays.

The matrix (`m`) changes one account at a time, but for a `.mcp.json` server. Its cursor is on
one cell, a server in one account, and the account's label and the cell are in brackets, as in
`[work]` and `[●]`. `←` and `→` move it from account to account, and the accounts scroll to keep
it in sight. `space` turns that account's server off or on in this project, through the same
dialog, with only that account picked. A `.mcp.json` server is turned on or off in the project's
`.claude/settings.local.json`, which every account reads, so its cell changes it for the whole
project, and the dialog's question names no account: `Turn on docs-search in this project?`.
`u` undoes the newest change. Once a change is made, the matrix shows the files read
again, the cursor on the same cell. On a cell with no server, `space` says so, as in
`work has no docs here.`, and on a cell that can't change it says why, as on a row:
`No account that has it has opened this project.` In the Codex column, `space` works as it does
on the server's row in Codex's MCP tab. A Codex cell shows the copy Codex starts: the project's
own where Codex trusts the project, else yours of that name.

Some cells only change everywhere, and there `space` does what `g` does on the row, for that
account alone. A server clausona keeps aside for one account, off in every project, is put back
in that account's `.claude.json`: `Turn on github in every project, for work?`. In the home
folder, where Codex's project config is your user config, a Codex cell changes that file. The
matrix takes no `g` or `d`, so a reason that names one says to press it on the server's row, as in
`… From its row, press d to delete the copy clausona kept.`

`d` on something git tracks opens the dialog with a warning,
`Git tracks deploy-check in app, so deleting changes the repo.`, and `o` there turns it off here
instead. `y` deletes it anyway.

Once a change is made, the status line says what was done and that `u` undoes it, as in
`Turned off eli5 in this project · u to undo`. A change that stopped says why. `u` opens a dialog
for the newest change, `Undo: Turned off eli5 in this project?`, and once it is done the status
line reads `Undid: Turned off eli5 in this project`, or says how many files it left alone and
why.
