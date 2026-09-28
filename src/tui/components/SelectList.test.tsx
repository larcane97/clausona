import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../lib/cli-style.js";
import { waitForFrame } from "../test-drive.js";
import { SelectList, type SelectListItem } from "./SelectList.js";

const QUOTA = "5h 61% | 7d 100% (cooldown)";

/** The first line of a single-item list rendered `columns` wide. */
async function row(item: SelectListItem, columns: number) {
  const { lastFrame, unmount } = render(
    <Box width={columns}>
      <SelectList items={[item]} index={0} />
    </Box>,
  );
  const frame = await waitForFrame(lastFrame, (f) => f.includes("✦"));
  unmount();
  return stripAnsi(frame).split("\n")[0] ?? "";
}

describe("SelectList", () => {
  // The label was the only part of a row allowed to shrink, so a quota reading or a doctor
  // summary beside it squeezed the profile name to `cl…` - or off the row entirely.
  it("keeps enough of the name to tell profiles apart when the meta is long", async () => {
    const line = await row({ id: "a", label: "claude:jaewon-yanolja-team", meta: QUOTA }, 34);

    // Fourteen characters and the ellipsis, where the old layout left `cl…`.
    expect(line).toMatch(/claude:jaewon-\S*…/);
  });

  it("keeps the name when the badge is long", async () => {
    const line = await row({ id: "a", label: "claude:personal", badge: "1 issue, 1 warning" }, 30);

    expect(line).toContain("claude:personal ");
  });

  it("keeps a short badge whole, cutting the meta instead", async () => {
    const line = await row({ id: "a", label: "codex:company-workspace", badge: "active", meta: QUOTA }, 44);

    expect(line).toMatch(/codex:company-\S* ● active 5h \S.*…/);
  });

  it("leaves a row that fits exactly as it is", async () => {
    const line = await row({ id: "a", label: "claude:default", badge: "active", meta: "5h 61% | 7d 12%" }, 60);

    expect(line).toContain("claude:default ● active 5h 61% | 7d 12%");
  });
});
