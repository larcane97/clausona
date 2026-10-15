import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { isFresh } from "../../core/quota.js";
import { truncate } from "../../lib/cli-style.js";
import {
  doctorSeverity,
  doctorSummary,
  fitModel,
  fitQuotaValue,
  formatAge,
  formatCurrency,
  localTimezoneLabel,
} from "../../lib/format.js";
import { displayName, isEnvMap } from "../../lib/profile-env.js";
import { describeSecretSource } from "../../lib/redact.js";
import { spendText } from "../../lib/route-render.js";
import type { DoctorProfileResult, ProfileListItem, QuotaSnapshot, QuotaWindow } from "../../types.js";
import { color, symbol } from "../theme.js";
import { textLines, useWidth } from "../use-width.js";
import { Badge } from "./Badge.js";
import { quotaColor } from "./QuotaCell.js";

function Row({
  label,
  value,
  valueColor,
  cut = "end",
}: {
  label: string;
  value: string;
  valueColor?: string;
  /**
   * Where the value is cut when it is longer than its line: always on one line, so that the panel
   * can count its lines to fit the terminal (see `fitPanel`). One line also stops character-by-
   * character wrapping in a narrow panel: an address or a path has no space to wrap at, so ink
   * broke it wherever the column ended. `middle` keeps both ends - the domain, the directory's
   * suffix - which is what tells one of them from the next.
   */
  cut?: "end" | "middle";
}) {
  return (
    <Box gap={1} width="100%" flexDirection="row">
      <Box width={12} flexShrink={0}>
        <Text color={color.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text color={valueColor ?? color.text} wrap={`truncate-${cut}`}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

/** The rule between two sections, with a blank line either side of it while the panel is spaced. */
function Separator({ spaced }: { spaced: boolean }) {
  return (
    <Box marginY={spaced ? 1 : 0} flexDirection="row" width="100%" overflow="hidden" height={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={1}>
        <Text color={color.dim}>{symbol.lineH.repeat(300)}</Text>
      </Box>
    </Box>
  );
}

const EM_DASH = "\u2014";

const QUOTA_STATE_NOTE: Record<Exclude<QuotaSnapshot["state"], "ok">, string> = {
  expired: "sign-in lapsed \u2014 clausona login",
  // The row beside the panel says `signed out`, as `csn list` and routing do.
  missing: "signed out — clausona login",
  cooldown: "rate limited, retrying later",
  error: "lookup failed",
};

/** Row's label box plus its gap: what a row's value does not get of the panel's width. */
const LABEL_COLUMN = 13;

/** A finding's arrow and the space after it: what its message does not get of the panel's width. */
const FINDING_INDENT = 2;

function QuotaRow({
  label,
  window,
  live,
  width,
}: {
  label: string;
  window?: QuotaWindow;
  live: boolean;
  width: number;
}) {
  if (!window) {
    return <Row label={label} value={EM_DASH} valueColor={color.muted} />;
  }

  return <Row label={label} value={fitQuotaValue(window, width)} valueColor={quotaColor(window, live)} />;
}

/**
 * The quota rows of an account, one element a line. `width` is a Row's value's, for the rows that
 * cut their own text to fit - a quota reading by what it drops - rather than leave it to ink,
 * which cuts from the end and takes the part that tells one value from another.
 */
function quotaRows(quota: QuotaSnapshot | undefined, width: number): ReactElement[] {
  if (!quota) {
    // The character itself: a JSX attribute string keeps a `…` escape as six characters.
    return [<Row key="quota" label="Quota" value="loading…" valueColor={color.muted} />];
  }

  const live = quota.state === "ok";
  const hasWindows = Boolean(quota.session ?? quota.weekly ?? quota.scoped);
  return [
    <QuotaRow key="session" label="Session" window={quota.session} live={live} width={width} />,
    <QuotaRow key="weekly" label="Weekly" window={quota.weekly} live={live} width={width} />,
    ...(quota.scoped
      ? [
          <QuotaRow
            key="scoped"
            label={truncate(quota.scoped.label, 12)}
            window={quota.scoped}
            live={live}
            width={width}
          />,
        ]
      : []),
    ...(quota.state !== "ok"
      ? [
          <Row
            key="note"
            label=""
            // Numbers shown for a failed lookup are a last-known reading, so say how old.
            value={
              hasWindows
                ? `${QUOTA_STATE_NOTE[quota.state]} · ${formatAge(quota.fetchedAt)}`
                : QUOTA_STATE_NOTE[quota.state]
            }
            valueColor={color.warning}
          />,
        ]
      : []),
  ];
}

/**
 * What an API profile is, one element a line: where it points, what it asks for, and where its
 * key comes from. Never the key, nor a command line: `profile.api` arrives from listProfiles
 * already through `redactProfile`, and the key row is `describeSecretSource`, the form
 * `config --show` uses.
 */
function apiRows(profile: ProfileListItem, width: number): ReactElement[] {
  const api = profile.api;
  if (!api) return [];
  // `profile.model`, as `list` reads it - not the env map read a second way here.
  const model = profile.model;
  // The model has a row of its own; the rest are counted rather than listed, because the
  // panel is a column and there can be twenty of them.
  const others = isEnvMap(profile.env) ? Object.keys(profile.env).filter((key) => key !== "ANTHROPIC_MODEL").length : 0;
  return [
    <Row key="endpoint" label="Endpoint" value={api.baseUrl} />,
    <Row key="auth" label="Auth" value={api.authScheme} valueColor={color.secondary} />,
    <Row key="key" label="Key" value={describeSecretSource(api.secret)} valueColor={color.secondary} />,
    <Row key="model" label="Model" value={fitModel(model, width)} valueColor={model ? color.text : color.muted} />,
    ...(others > 0
      ? [<Row key="settings" label="Settings" value={`${others} set`} valueColor={color.secondary} />]
      : []),
    ...budgetRows(profile.quota, width),
  ];
}

/**
 * An API profile's spend against its limit, as last read (by `route budget`, or a routed run): the
 * dashboard reads nothing for it, since that would resolve its key. Nothing when there is no
 * reading.
 */
function budgetRows(quota: QuotaSnapshot | undefined, width: number): ReactElement[] {
  const budget = quota?.budget;
  if (!quota || !budget) return [];
  const live = quota.state === "ok" && isFresh(quota, Date.now());
  return [
    <QuotaRow key="budget" label="Budget" window={budget} live={live} width={width} />,
    <Row
      key="spend"
      label=""
      value={`${spendText(budget)}${live ? "" : ` · ${formatAge(quota.fetchedAt)}`}`}
      valueColor={color.secondary}
    />,
  ];
}

/** The usage section's lines: the time zone, then today, this week and the total. */
const USAGE_ROWS = 4;

/** How the panel is laid out in the lines it has. */
type PanelFit = {
  /** Padding inside the border, and a blank line between the sections and around each rule. */
  spaced: boolean;
  /** The usage section. */
  usage: boolean;
  /** A blank line before each finding, and before the line that counts the rest. */
  findingGap: boolean;
  /** The findings drawn, from the first: the rest are counted on one line. */
  shown: number;
  /** Taller than its lines even so: the panel is given their height, and cut at its bottom edge. */
  cut: boolean;
};

/**
 * The panel's lines, `spaced` or not and with or without its usage section, findings aside: the
 * border, the header, the details, and the sections each after a rule - the quota (or the
 * endpoint), the usage, and the health row when there is a doctor result.
 */
function frameLines(
  parts: { details: number; middle: number; health: boolean },
  spaced: boolean,
  usage: boolean,
): number {
  const blank = spaced ? 1 : 0;
  /** A rule and the blank lines either side of it. */
  const rule = 1 + 2 * blank;
  return (
    2 +
    2 * blank +
    1 +
    blank +
    parts.details +
    rule +
    parts.middle +
    (usage ? rule + USAGE_ROWS : 0) +
    (parts.health ? rule + 1 : 0)
  );
}

/**
 * How the panel fits `rows` lines, when a screen gives it a height. Everything, spaced as it
 * always was, when that fits. Short of that it gives up, in turn, the blank lines between its
 * findings, then those between its sections and inside its border, then the findings that do
 * not fit - counted on one line, which points at Health check where they all are - then its usage
 * section, which the Usage screen has too; and, when even that is taller, it is cut at its bottom
 * edge, so that what is cut is the panel's and not the top of the screen. `findings` are the
 * lines each finding's message takes.
 */
function fitPanel(
  parts: { details: number; middle: number; health: boolean },
  findings: number[],
  rows: number | undefined,
): PanelFit {
  const every = findings.length;
  if (rows === undefined) return { spaced: true, usage: true, findingGap: true, shown: every, cut: false };
  /** The lines the first `shown` findings take, and the line that counts the rest. */
  const findingLines = (gap: boolean, shown: number) =>
    findings.slice(0, shown).reduce((sum, lines) => sum + lines + (gap ? 1 : 0), 0) +
    (shown < every ? 1 + (gap ? 1 : 0) : 0);
  for (const [spaced, gap] of [
    [true, true],
    [true, false],
    [false, false],
  ] as const) {
    if (frameLines(parts, spaced, true) + findingLines(gap, every) <= rows) {
      return { spaced, usage: true, findingGap: gap, shown: every, cut: false };
    }
  }
  for (const usage of [true, false]) {
    const room = rows - frameLines(parts, false, usage);
    let shown = every;
    while (shown > 0 && findingLines(false, shown) > room) shown -= 1;
    if (findingLines(false, shown) <= room) return { spaced: false, usage, findingGap: false, shown, cut: false };
  }
  return { spaced: false, usage: false, findingGap: false, shown: 0, cut: true };
}

/**
 * A profile at a glance, beside the list on the dashboard and on Profiles. `rows`, when the screen
 * knows the terminal's height, is the most lines it may take: see `fitPanel`.
 */
export function ProfilePreview({
  profile,
  doctor,
  rows,
}: {
  profile?: ProfileListItem;
  doctor?: DoctorProfileResult;
  rows?: number;
}) {
  // The panel's width inside its border and padding, measured on its header: the panel sits in
  // two screens that lay it out differently (see `useWidth`). Infinite until ink has laid it out.
  const [inner, innerWidth] = useWidth();
  const valueWidth = Math.max(0, innerWidth - LABEL_COLUMN);
  if (!profile) {
    return (
      <Box
        borderStyle="round"
        borderColor={color.dim}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <Text color={color.muted}>No profile selected.</Text>
      </Box>
    );
  }

  const isApi = profile.kind === "api";
  // An API profile has no account email; its label stands in, exactly as it does in `list` and
  // in the doctor. Blank-aware, so a hand-edited blank label does not hide a real email behind
  // whitespace.
  const details = [
    <Row key="account" label="Account" value={displayName(profile)} cut="middle" />,
    ...(profile.orgName ? [<Row key="org" label="Org" value={profile.orgName} />] : []),
    <Row
      key="config"
      label="Config"
      value={profile.configDir.replace(/^\/Users\/[^/]+/, "~")}
      valueColor={color.muted}
      cut="middle"
    />,
    ...(!profile.isPrimary
      ? [
          <Row
            key="sessions"
            label="Sessions"
            value={profile.mergeSessions ? "merged" : "separated"}
            valueColor={profile.mergeSessions ? color.warning : color.secondary}
          />,
        ]
      : []),
    // An API profile's model is in its endpoint section, with a dash when none is set: an
    // endpoint nearly always needs one. For an account, pinning none is the usual case - Claude
    // Code picks - so the row is only there when there is a model.
    ...(!isApi && profile.model !== undefined
      ? [<Row key="model" label="Model" value={fitModel(profile.model, valueWidth)} />]
      : []),
  ];
  // An endpoint has no plan quota, and nothing ever fetches one for it - so the quota rows would
  // sit on "loading…" forever. What it is replaces what it does not have.
  const middle = isApi ? apiRows(profile, valueWidth) : quotaRows(profile.quota, valueWidth);
  const issues = doctor?.issues ?? [];
  // Until ink has laid the panel out its width is unknown, and a message's lines with it: then no
  // finding is counted as fitting, rather than one counted short pushing the frame past the
  // terminal. The width is measured a moment later, and the findings drawn.
  const measured = Number.isFinite(innerWidth);
  const findingLines = issues.map((issue) =>
    measured ? textLines(issue.message, innerWidth - FINDING_INDENT) : Number.POSITIVE_INFINITY,
  );
  const fit = fitPanel({ details: details.length, middle: middle.length, health: Boolean(doctor) }, findingLines, rows);
  const left = issues.length - fit.shown;

  const header = (
    <Box key="header" ref={inner} gap={1} justifyContent="space-between" flexShrink={0}>
      <Text color={color.text} bold wrap="truncate-end">
        {profile.name}
      </Text>
      <Box gap={1} flexShrink={0}>
        {isApi && <Badge label="API" variant="info" />}
        {profile.isActive && (
          <Box backgroundColor={color.brand} paddingX={1} flexShrink={0}>
            <Text color="#ffffff" bold>
              ACTIVE
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
  // Any finding at all, warning included, is something to look at - so the icon follows the
  // issue list rather than `healthy`, and the colour comes from the rule the doctor list uses
  // too, which is what keeps the two surfaces from grading the same profile differently.
  const health = doctor && (
    <Row
      key="health"
      label="Health"
      value={`${doctor.issues.length === 0 ? symbol.check : symbol.diamond} ${doctorSummary(doctor.issues)}`}
      valueColor={color[doctorSeverity(doctor.issues)]}
    />
  );
  const more = left > 0 && (
    <Box key="more" marginTop={fit.findingGap ? 1 : 0}>
      <Text color={color.muted} wrap="truncate-end">
        {`… ${left} more in Health check`}
      </Text>
    </Box>
  );
  const panel = {
    borderStyle: "round",
    borderColor: profile.isActive ? color.brand : color.dim,
    paddingX: 2,
    paddingY: fit.spaced ? 1 : 0,
    flexDirection: "column",
    flexShrink: 1,
    overflow: "hidden",
  } as const;

  // Cut: every line it draws is one line, and it draws those that fit from the top. Not left to
  // the border's overflow: ink keeps only the innermost of nested clips, so each row's own clip
  // drew it over the border, and past it over whatever is below the panel.
  if (fit.cut && rows !== undefined) {
    const lines = [
      header,
      ...details,
      <Separator key="rule" spaced={false} />,
      ...middle,
      ...(doctor ? [<Separator key="health-rule" spaced={false} />, health, more] : []),
    ].filter(Boolean);
    return (
      <Box {...panel} height={rows}>
        {lines.slice(0, Math.max(1, rows - 2))}
      </Box>
    );
  }

  return (
    <Box {...panel}>
      {header}

      <Box flexDirection="column" marginTop={fit.spaced ? 1 : 0} flexShrink={0}>
        {details}
      </Box>

      <Separator spaced={fit.spaced} />

      <Box flexDirection="column" flexShrink={0}>
        {middle}
      </Box>

      {fit.usage && (
        <>
          <Separator spaced={fit.spaced} />
          <Box flexDirection="column" flexShrink={0}>
            <Text color={color.dim} wrap="truncate-end">
              {localTimezoneLabel()}
            </Text>
            <Row
              label="Today"
              value={formatCurrency(profile.today.cost)}
              valueColor={profile.today.cost > 0 ? color.text : color.muted}
            />
            <Row
              label="This Week"
              value={formatCurrency(profile.week.cost)}
              valueColor={profile.week.cost > 0 ? color.text : color.muted}
            />
            <Row
              label="Total"
              value={formatCurrency(profile.total.cost)}
              valueColor={profile.total.cost > 0 ? color.brandLight : color.muted}
            />
          </Box>
        </>
      )}

      {/* Health. The whole section waits for a result rather than guessing at one, so
          there is no "unknown" state to render: until the doctor has run, the panel says
          nothing about health at all. */}
      {doctor && (
        <>
          <Separator spaced={fit.spaced} />
          <Box flexDirection="column" flexShrink={0}>
            {health}
            {issues.slice(0, fit.shown).map((issue) => (
              <Box key={issue.message} gap={1} marginTop={fit.findingGap ? 1 : 0}>
                {/* Fixed: beside a message longer than the line, a shrinkable arrow is given
                    its share of the shrink, rounds to no width, and the message runs into it. */}
                <Box flexShrink={0}>
                  <Text color={color.warning}>{symbol.arrow}</Text>
                </Box>
                <Text color={color.warning}>{issue.message}</Text>
              </Box>
            ))}
            {more}
          </Box>
        </>
      )}
    </Box>
  );
}
