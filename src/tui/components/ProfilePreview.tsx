import { Box, type DOMElement, Text } from "ink";
import type { RefObject } from "react";
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
import type { DoctorProfileResult, ProfileListItem, QuotaSnapshot, QuotaWindow } from "../../types.js";
import { color, symbol } from "../theme.js";
import { useWidth } from "../use-width.js";
import { Badge } from "./Badge.js";
import { quotaColor } from "./QuotaCell.js";

function Row({
  label,
  value,
  valueColor,
  cut,
}: {
  label: string;
  value: string;
  valueColor?: string;
  /**
   * Keep the value on one line, cut where it is least missed. Prevents character-by-character
   * wrapping in a narrow panel: an address or a path has no space to wrap at, so ink broke it
   * wherever the column ended. `middle` keeps both ends - the domain, the directory's suffix -
   * which is what tells one of them from the next.
   */
  cut?: "end" | "middle";
}) {
  return (
    <Box gap={1} width="100%" flexDirection="row">
      <Box width={12} flexShrink={0}>
        <Text color={color.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow={cut ? "hidden" : undefined}>
        <Text color={valueColor ?? color.text} wrap={cut ? `truncate-${cut}` : undefined}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

function Separator() {
  return (
    <Box marginBottom={1} flexDirection="row" width="100%" overflow="hidden" height={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={1}>
        <Text color={color.dim}>{symbol.lineH.repeat(300)}</Text>
      </Box>
    </Box>
  );
}

const EM_DASH = "\u2014";

const QUOTA_STATE_NOTE: Record<Exclude<QuotaSnapshot["state"], "ok">, string> = {
  expired: "sign-in lapsed \u2014 clausona login",
  missing: "no stored credential",
  cooldown: "rate limited, retrying later",
  error: "lookup failed",
};

/** Row's label box plus its gap: what a row's value does not get of the panel's width. */
const LABEL_COLUMN = 13;

/**
 * The columns a Row's value has, for the rows that cut their own text to fit - a model id from
 * the middle, a quota reading by what it drops - rather than leave it to ink, which cuts from
 * the end and takes the part that tells one value from another. Measured: the panel sits in two
 * screens that lay it out differently (see `useWidth`).
 */
function useValueWidth(): [RefObject<DOMElement | null>, number] {
  const [panel, width] = useWidth();
  return [panel, Math.max(0, width - LABEL_COLUMN)];
}

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
    return <Row label={label} value={EM_DASH} valueColor={color.muted} cut="end" />;
  }

  return <Row label={label} value={fitQuotaValue(window, width)} valueColor={quotaColor(window, live)} cut="end" />;
}

function QuotaSection({ quota, width }: { quota?: QuotaSnapshot; width: number }) {
  if (!quota) {
    // The character itself: a JSX attribute string keeps a `\u2026` escape as six characters.
    return <Row label="Quota" value="loading…" valueColor={color.muted} cut="end" />;
  }

  const live = quota.state === "ok";
  const hasWindows = Boolean(quota.session ?? quota.weekly ?? quota.scoped);
  return (
    <>
      <QuotaRow label="Session" window={quota.session} live={live} width={width} />
      <QuotaRow label="Weekly" window={quota.weekly} live={live} width={width} />
      {quota.scoped && (
        <QuotaRow label={truncate(quota.scoped.label, 12)} window={quota.scoped} live={live} width={width} />
      )}
      {quota.state !== "ok" && (
        <Row
          label=""
          // Numbers shown for a failed lookup are a last-known reading, so say how old.
          value={
            hasWindows
              ? `${QUOTA_STATE_NOTE[quota.state]} \u00b7 ${formatAge(quota.fetchedAt)}`
              : QUOTA_STATE_NOTE[quota.state]
          }
          valueColor={color.warning}
          cut="end"
        />
      )}
    </>
  );
}

/**
 * What an API profile is: where it points, what it asks for, and where its key comes from.
 * Never the key, nor a command line: `profile.api` arrives from listProfiles already through
 * `redactProfile`, and the key row is `describeSecretSource`, the form `config --show` uses.
 */
function ApiSection({ profile, width }: { profile: ProfileListItem; width: number }) {
  const api = profile.api;
  if (!api) return null;
  // `profile.model`, as `list` reads it - not the env map read a second way here.
  const model = profile.model;
  // The model has a row of its own; the rest are counted rather than listed, because the
  // panel is a column and there can be twenty of them.
  const others = isEnvMap(profile.env) ? Object.keys(profile.env).filter((key) => key !== "ANTHROPIC_MODEL").length : 0;
  return (
    <>
      <Row label="Endpoint" value={api.baseUrl} cut="end" />
      <Row label="Auth" value={api.authScheme} valueColor={color.secondary} />
      <Row label="Key" value={describeSecretSource(api.secret)} valueColor={color.secondary} />
      <Row label="Model" value={fitModel(model, width)} valueColor={model ? color.text : color.muted} cut="end" />
      {others > 0 && <Row label="Settings" value={`${others} set`} valueColor={color.secondary} />}
    </>
  );
}

export function ProfilePreview({ profile, doctor }: { profile?: ProfileListItem; doctor?: DoctorProfileResult }) {
  const [details, valueWidth] = useValueWidth();
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

  return (
    <Box
      borderStyle="round"
      borderColor={profile.isActive ? color.brand : color.dim}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
      flexShrink={1}
      overflow="hidden"
    >
      {/* Header */}
      <Box gap={1} marginBottom={1} justifyContent="space-between" flexShrink={0}>
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

      {/* Details */}
      <Box ref={details} flexDirection="column" gap={0} marginBottom={1} flexShrink={0}>
        {/* An API profile has no account email; its label stands in, exactly as it does in
            `list` and in the doctor. Blank-aware, so a hand-edited blank label does not
            hide a real email behind whitespace. */}
        <Row label="Account" value={displayName(profile)} cut="middle" />
        {profile.orgName && <Row label="Org" value={profile.orgName} />}
        <Row
          label="Config"
          value={profile.configDir.replace(/^\/Users\/[^/]+/, "~")}
          valueColor={color.muted}
          cut="middle"
        />
        {!profile.isPrimary && (
          <Row
            label="Sessions"
            value={profile.mergeSessions ? "merged" : "separated"}
            valueColor={profile.mergeSessions ? color.warning : color.secondary}
          />
        )}
        {/* An API profile's model is in its endpoint section, with a dash when none is set:
            an endpoint nearly always needs one. For an account, pinning none is the usual
            case - Claude Code picks - so the row is only there when there is a model. */}
        {!isApi && profile.model !== undefined && (
          <Row label="Model" value={fitModel(profile.model, valueWidth)} cut="end" />
        )}
      </Box>

      <Separator />

      {/* An endpoint has no plan quota, and nothing ever fetches one for it - so the quota
          rows would sit on "loading…" forever. What it is replaces what it does not have. */}
      <Box flexDirection="column" gap={0} marginBottom={1} flexShrink={0}>
        {isApi ? (
          <ApiSection profile={profile} width={valueWidth} />
        ) : (
          <QuotaSection quota={profile.quota} width={valueWidth} />
        )}
      </Box>

      <Separator />

      {/* Usage */}
      <Box flexDirection="column" gap={0} marginBottom={doctor ? 1 : 0} flexShrink={0}>
        <Box gap={1}>
          <Text color={color.dim}>{localTimezoneLabel()}</Text>
        </Box>
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

      {/* Health. The whole section waits for a result rather than guessing at one, so
          there is no "unknown" state to render: until the doctor has run, the panel says
          nothing about health at all. */}
      {doctor && (
        <Box flexDirection="column" flexShrink={0}>
          <Separator />
          {/* Any finding at all, warning included, is something to look at - so the icon
              follows the issue list rather than `healthy`, and the colour comes from the
              rule the doctor list uses too, which is what keeps the two surfaces from
              grading the same profile differently. */}
          <Row
            label="Health"
            value={`${doctor.issues.length === 0 ? symbol.check : symbol.diamond} ${doctorSummary(doctor.issues)}`}
            valueColor={color[doctorSeverity(doctor.issues)]}
          />
          {doctor.issues.map((issue) => (
            <Box key={issue.message} gap={1} marginTop={1}>
              {/* Fixed: beside a message longer than the line, a shrinkable arrow is given
                  its share of the shrink, rounds to no width, and the message runs into it. */}
              <Box flexShrink={0}>
                <Text color={color.warning}>{symbol.arrow}</Text>
              </Box>
              <Text color={color.warning}>{issue.message}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
