import { Text } from "ink";
import { color, symbol } from "../theme.js";

type BadgeVariant = "active" | "healthy" | "warning" | "error" | "info" | "muted" | "primary";

const variantMap: Record<BadgeVariant, { fg: string; icon: string }> = {
  active:  { fg: color.brand,   icon: symbol.dot },
  healthy: { fg: color.healthy, icon: symbol.check },
  warning: { fg: color.warning, icon: symbol.diamond },
  error:   { fg: color.error,   icon: symbol.cross },
  info:    { fg: color.info,    icon: symbol.dot },
  muted:   { fg: color.muted,   icon: symbol.circle },
  primary: { fg: color.accent,  icon: symbol.diamond },
};

export function Badge({ label, variant = "muted" }: { label: string; variant?: BadgeVariant }) {
  const v = variantMap[variant];
  return (
    <Text color={v.fg}>
      {v.icon} {label}
    </Text>
  );
}
