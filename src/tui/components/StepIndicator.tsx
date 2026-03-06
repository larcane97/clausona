import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";

type Step = { label: string };

export function StepIndicator({
  steps,
  current,
}: {
  steps: Step[];
  current: number;
}) {
  return (
    <Box gap={1}>
      {steps.map((step, i) => {
        const isDone = i < current;
        const isActive = i === current;
        const stepColor = isDone
          ? color.healthy
          : isActive
            ? color.brand
            : color.dim;
        const icon = isDone ? symbol.check : isActive ? symbol.cursor : symbol.circle;

        return (
          <Box key={step.label}>
            <Text color={stepColor}>
              {icon}
            </Text>
            <Text color={isActive ? color.text : isDone ? color.secondary : color.muted}>
              {" "}{step.label}
            </Text>
            {i < steps.length - 1 && (
              <Text color={color.dim}> {symbol.lineH}{symbol.lineH} </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
