/**
 * How long a test case that starts real processes may run, and how long it lets each one run.
 * Only for tests: nothing in the app imports it.
 *
 * A case that runs only code in the worker keeps vitest's 5 s default, so a hang there still
 * fails within seconds. A case that starts a process - a shell, git, node, the `security`
 * stand-in - waits on the machine instead. With every core busy (a load average of 45 to 65)
 * one zsh running the hook took 16 s to return, four runs of the `security` stand-in 16 s, and
 * a case of nine git and helper runs 25 s, where an idle machine does each in well under a
 * second. Such a case asks for this limit: twice the slowest of those, for a machine busier still.
 */
export const SPAWNING_TEST_TIMEOUT_MS = 60_000;

/**
 * How long a test lets one process it started run before it kills it. Below the case's limit,
 * so the process is gone, and the case fails on what it got back, before vitest gives up on the
 * case and starts the next one. A spawnSync needs it most: vitest's own timeout cannot fire
 * while one blocks the worker.
 */
export const SPAWN_TIMEOUT_MS = 45_000;
