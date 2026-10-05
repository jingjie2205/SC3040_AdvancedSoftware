import { z } from "zod";
import { GAMIFICATION_RULES as R } from "./config";
import { todayISO } from "./dates";
import { CHALLENGE_METRICS } from "./types";

/**
 * Shared by the forms and the mock API, so both reject the same input as the server.
 */

function score(label: string) {
  return z
    .number({ invalid_type_error: `Rate your ${label}`, required_error: `Rate your ${label}` })
    .int(`Rate your ${label}`)
    .min(R.checkInScale.min, `Rate your ${label}`)
    .max(R.checkInScale.max, `Rate your ${label}`);
}

export const checkInSchema = z.object({
  muscleFatigue: score("muscle fatigue"),
  mood: score("mood"),
  dietAdherence: score("diet adherence"),
});

export type CheckInInput = z.infer<typeof checkInSchema>;

const isoDate = (message: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, message);

export const challengeSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Give the challenge a name")
      .max(R.challengeTitleMax, `Keep the name under ${R.challengeTitleMax} characters`),
    metric: z.enum(CHALLENGE_METRICS),
    targetValue: z
      .number({ invalid_type_error: "Enter a target" })
      .int("Use a whole number")
      .min(1, "The target must be at least 1")
      .max(R.challengeTargetMax, `The target can be at most ${R.challengeTargetMax.toLocaleString()}`),
    startDate: isoDate("Pick a start date").refine((d) => d >= todayISO(), "The start date can't be in the past"),
    endDate: isoDate("Pick an end date"),
    inviteeIds: z
      .array(z.string())
      .max(R.challengeMaxInvitees, `You can invite up to ${R.challengeMaxInvitees} athletes`),
  })
  .refine((c) => c.endDate >= c.startDate, {
    path: ["endDate"],
    message: "The end date must be on or after the start date",
  });

export type ChallengeInput = z.infer<typeof challengeSchema>;
