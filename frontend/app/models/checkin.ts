
export type CheckInDatesResponse = {
  user_id: string;
  dates: string[]; 
};

export type CheckInStreakResponse = {
  user_id: string;
  streak: number;
};