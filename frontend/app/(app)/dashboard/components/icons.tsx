import { ActivityType } from "@/lib/training/types";
import { Activity, Bike, Dumbbell, Footprints, Waves } from "lucide-react";

export function getActivityIcon(activityType: ActivityType) {
  switch (activityType) {
        case "run":
        return Footprints;
    case "gym":
      return Dumbbell;
    case "cycling":
      return Bike;
    case "bodyweight":
      return Activity;
    default:
      return Activity;
  }
}
