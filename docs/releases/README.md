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
   `install.sh` and `install.ps1`. Its `npm` job then publishes the same `clausona.js` to npm
   (see below).

## Publishing to npm

The package `clausona` on npm is the release's `clausona.js` with a package.json, the README and
the LICENSE around it. [scripts/npm-package.mjs](../../scripts/npm-package.mjs) writes it, and
refuses a bundle whose `--version` is not the version in `package.json`.

The `npm` job in release.yml signs in to npm with trusted publishing, so no npm token is stored in
the repository. npm lets a workflow publish only a package that already exists and names that
workflow as its trusted publisher. So the first version went up by hand, once: 0.14.0-beta, on
2026-11-10. 0.14.1-beta was the first version the `npm` job published. The steps below are kept for
a new package or a trusted publisher that has to be set up again.

### One-time setup

1. Sign in to npm. Create an account on npmjs.com if you have none, turn on two-factor
   authentication in its account settings, then run `npm login` and check `npm whoami`.

2. Publish the latest GitHub release by hand, from its own `clausona.js`. Run this at the top of a
   checkout that has `scripts/npm-package.mjs` and whose `package.json` has that release's version:

   ```bash
   tag="v$(node -p "require('./package.json').version")"
   mkdir -p /tmp/clausona-npm
   curl -fsSL -o /tmp/clausona-npm/clausona.js "https://github.com/larcane97/clausona/releases/download/$tag/clausona.js"
   curl -fsSL -o /tmp/clausona-npm/clausona.js.sha256 "https://github.com/larcane97/clausona/releases/download/$tag/clausona.js.sha256"
   (cd /tmp/clausona-npm && shasum -a 256 -c clausona.js.sha256)
   node scripts/npm-package.mjs --bundle /tmp/clausona-npm/clausona.js
   npm pack --dry-run ./dist/npm   # LICENSE, README.md, clausona.js, package.json
   npm publish ./dist/npm --tag latest --access public
   ```

   Keep the `./`: npm reads a bare `dist/npm` as a GitHub repository. `--tag latest` is required
   because the version is a prerelease (`0.13.0-beta`), and it is what makes a plain
   `npm install -g clausona` install it. npm asks for your two-factor code.

3. Name release.yml as the package's trusted publisher, on the day you push the next release tag:
   a new trusted publisher expires when its first publish does not come within two days. If that
   happens, delete it and add it again. On npmjs.com, open the package's Settings, then Trusted Publisher, choose
   GitHub Actions and enter user `larcane97`, repository `clausona` and workflow filename
   `release.yml`, with no environment. Under the allowed actions, tick `npm publish`. Or, with
   npm 11.15 or later:

   ```bash
   npx npm@^11.15.0 trust github clausona --file release.yml --repo larcane97/clausona --allow-publish --yes
   ```

4. Push the next release tag as usual. The `npm` job's log should end with
   `+ clausona@<version>`, and the package page then shows where it was built (provenance).

5. Optionally, in the package's Settings, under Publishing access, choose "Require two-factor
   authentication and disallow tokens". Trusted publishing does not use a token, so the `npm` job
   keeps working, and a publish by hand still works with your two-factor code.

### When the npm job fails

The release run turns red, but the GitHub release is out either way. Rerun the job from the
Actions tab once the cause is fixed; it skips a version that is already on npm. Or publish that
version by hand as in step 2.

A copy installed with npm never replaces itself. `clausona update`, the dashboard's Update and the
question after commands tell its user to run `npm install -g clausona@latest`.
