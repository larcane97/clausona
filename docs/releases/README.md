# Release notes

Each release has its notes here, in `v<version>.md`. The release workflow puts that file at the
top of the GitHub release, and GitHub's list of merged PRs follows it. A test fails while
`package.json` names a version that has no notes file, so a release can't go out without one.

## What to write

Write for someone who uses clausona and hasn't read the PRs.

- Start with a sentence or two on what the release is for.
- Give each new feature its own section: what it does for you, the commands to try, and a link
  to its docs.
- Describe a fix by what went wrong for the user, not by what the code did.
- Say what a user has to do once after updating, such as reinstall a plugin or open a new shell.
  Leave this out when there is nothing.
- End with how to update: `clausona update` or Update on the dashboard, and the installer for
  0.3.0-beta and earlier, which can't update themselves.

Leave out docs, tests, CI and chores unless a user would notice them. They are still in GitHub's
list below the notes.

Keep the voice plain: short paragraphs, the words a user would use, and real commands and output
rather than adjectives. No heading at the top; the release title is the tag. Links point at
`https://github.com/larcane97/clausona/blob/main/...`, since relative links break on the release
page. [v0.6.0-beta.md](v0.6.0-beta.md) is an example.

## Releasing

1. Open a `chore: release <version>` PR that bumps `version` in `package.json` and adds
   `docs/releases/v<version>.md`. Use a minor bump for features and a patch bump for fixes only.
2. Merge it once CI passes.
3. Push a lightweight tag `v<version>` on the merge commit.
   [release.yml](../../.github/workflows/release.yml) checks that the tag matches `package.json`,
   builds and tests, and publishes the release with these notes, `clausona.js`, its SHA-256,
   `install.sh` and `install.ps1`.
