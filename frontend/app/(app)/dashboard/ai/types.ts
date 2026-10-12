export interface Exercise {
  name: string;
  sets: number;
  reps: string;
  targetWeight: string;
}

export interface WorkoutPlan {
  title: string;
  focus: string;
  exercises: Exercise[];
}

export interface NutritionPlan {
  title: string;
  targetCalories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  mealHighlights: string[];
}

export interface NutritionScheduleDay {
  date: string;
  activity: string;
  targetCalories: number;
}

export type ActivityType = "cycling" | "run" | "gym" | "bodyweight";
export type IntensityBand = "light" | "push" | "deload";
export type SessionStatus = "planned" | "completed" | "skipped";

export interface RoutinePlanOption {
  id: string;
  goal?: string | null;
  status: string;
  start_date: string;
  end_date: string;
}

export interface RecommendedPlannedSession {
  date: string;
  activity_type: ActivityType;
  target_duration_min: number;
  intensity_band: IntensityBand;
  target_volume?: number | null;
  status?: SessionStatus;
}

export interface WeeklyTrainingDay {
  date: string;
  activity_type: ActivityType | "rest";
  target_duration_min: number | null;
  intensity_band: IntensityBand | null;
  target_volume?: number | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  hasPlannedSession?: boolean;
  plannedSession?: RecommendedPlannedSession | null;
  hasNutritionPlan?: boolean;
  nutritionPlan?: any;
  nutritionSchedule?: NutritionScheduleDay[] | null;
  weeklyTrainingPlan?: WeeklyTrainingDay[] | null;
}