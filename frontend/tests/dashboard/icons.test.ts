import { describe, expect, it } from "vitest";
import { Activity, Bike, Dumbbell, Footprints } from "lucide-react";
import { getActivityIcon } from "@/app/(app)/dashboard/components/icons";

describe("getActivityIcon", () => {
  it.each([
    ["run", Footprints],
    ["gym", Dumbbell],
    ["cycling", Bike],
    ["bodyweight", Activity],
  ] as const)("returns the icon for %s activity", (activityType, icon) => {
    expect(getActivityIcon(activityType)).toBe(icon);
  });

  it("uses the activity icon for unknown activity types", () => {
    expect(getActivityIcon("unknown" as never)).toBe(Activity);
  });
});
