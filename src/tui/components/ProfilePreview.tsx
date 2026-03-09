import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";
import { formatCurrency, localTimezoneLabel } from "../../lib/format.js";
import type { DoctorProfileResult, ProfileListItem } from "../../types.js";

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <Box gap={1} width="100%" flexDirection="row">
      <Box width={12} flexShrink={0}>
        <Text color={color.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={valueColor ?? color.text}>{value}</Text>
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

export function ProfilePreview({
  profile,
  doctor,
}: {
  profile?: ProfileListItem;
  doctor?: DoctorProfileResult;
}) {
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

  const healthColor = doctor
    ? doctor.healthy
      ? color.healthy
      : color.warning
    : color.muted;

  const healthLabel = doctor
    ? doctor.healthy
      ? `${symbol.check} healthy`
      : `${symbol.diamond} ${doctor.issues.length} issue(s)`
    : `${symbol.circle} unknown`;

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
        <Text color={color.text} bold wrap="truncate-end">{profile.name}</Text>
        {profile.isActive && (
          <Box backgroundColor={color.brand} paddingX={1} flexShrink={0}>
            <Text color="#ffffff" bold>ACTIVE</Text>
          </Box>
        )}
      </Box>

      {/* Details */}
      <Box flexDirection="column" gap={0} marginBottom={1} flexShrink={0}>
        <Row label="Account" value={profile.email} />
        {profile.orgName && <Row label="Org" value={profile.orgName} />}
        <Row label="Config" value={profile.configDir.replace(/^\/Users\/[^/]+/, "~")} valueColor={color.muted} />
        {!profile.isPrimary && (
          <Row label="Sessions" value={profile.mergeSessions ? "merged" : "separated"} valueColor={profile.mergeSessions ? color.warning : color.secondary} />
        )}
      </Box>

      <Separator />

      {/* Usage */}
      <Box flexDirection="column" gap={0} marginBottom={doctor ? 1 : 0} flexShrink={0}>
        <Box gap={1}>
          <Text color={color.dim}>{localTimezoneLabel()}</Text>
        </Box>
        <Row label="Today" value={formatCurrency(profile.today.cost)} valueColor={profile.today.cost > 0 ? color.text : color.muted} />
        <Row label="This Week" value={formatCurrency(profile.week.cost)} valueColor={profile.week.cost > 0 ? color.text : color.muted} />
        <Row label="Total" value={formatCurrency(profile.total.cost)} valueColor={profile.total.cost > 0 ? color.brandLight : color.muted} />
      </Box>

      {/* Health */}
      {doctor && (
      <Box flexDirection="column" flexShrink={0}>
          <Separator />
          <Row label="Health" value={healthLabel} valueColor={healthColor} />
          {doctor.issues.map((issue) => (
            <Box key={issue.message} gap={1} marginTop={1}>
              <Text color={color.warning}>{symbol.arrow}</Text>
              <Text color={color.warning}>{issue.message}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
