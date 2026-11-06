export const DAY_NAMES = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

export type DayName = (typeof DAY_NAMES)[number];

export interface Hours {
  start: string;
  end: string;
  days: readonly DayName[];
}

function toMinutes(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function dayName(dayIndex: number): DayName {
  return DAY_NAMES[((dayIndex % 7) + 7) % 7] ?? "sun";
}

/** Hours run from start up to end. An end at or before start runs past midnight. */
export function isWithinHours(date: Date, hours: Hours): boolean {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  const today = hours.days.includes(dayName(date.getDay()));
  const yesterday = hours.days.includes(dayName(date.getDay() - 1));

  if (start === end) return today;
  if (start < end) return today && now >= start && now < end;
  return (today && now >= start) || (yesterday && now < end);
}

/** Returns the next time these hours begin, or null if no days are active. */
export function nextStart(date: Date, hours: Hours): number | null {
  const start = toMinutes(hours.start);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + offset,
      Math.floor(start / 60),
      start % 60,
    );
    if (
      candidate.getTime() > date.getTime() &&
      hours.days.includes(dayName(candidate.getDay()))
    ) {
      return candidate.getTime();
    }
  }
  return null;
}
