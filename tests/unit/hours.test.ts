import { describe, expect, it } from "vitest";
import {
  currentEnd,
  isWithinHours,
  nextStart,
  type DayName,
  type Hours,
} from "../../src/server/domain/hours.js";

const ALL_DAYS: DayName[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const OFFICE: Hours = { start: "09:00", end: "18:00", days: ALL_DAYS };

// November 6, 2026 is a Friday.
const friday = (hour: number, minute = 0): Date =>
  new Date(2026, 10, 6, hour, minute);

describe("isWithinHours", () => {
  it("includes the start and excludes the end", () => {
    expect(isWithinHours(friday(8, 59), OFFICE)).toBe(false);
    expect(isWithinHours(friday(9, 0), OFFICE)).toBe(true);
    expect(isWithinHours(friday(17, 59), OFFICE)).toBe(true);
    expect(isWithinHours(friday(18, 0), OFFICE)).toBe(false);
  });

  it("respects active days", () => {
    const weekdays: Hours = { ...OFFICE, days: ["mon"] };
    expect(isWithinHours(friday(10), weekdays)).toBe(false);
    expect(isWithinHours(new Date(2026, 10, 9, 10), weekdays)).toBe(true);
  });

  it("supports hours past midnight, counted from the start day", () => {
    const night: Hours = { start: "22:00", end: "02:00", days: ["fri"] };
    expect(isWithinHours(friday(21, 59), night)).toBe(false);
    expect(isWithinHours(friday(23), night)).toBe(true);
    expect(isWithinHours(new Date(2026, 10, 7, 1), night)).toBe(true);
    expect(isWithinHours(new Date(2026, 10, 7, 2), night)).toBe(false);
    expect(isWithinHours(friday(1), night)).toBe(false);
  });

  it("treats matching start and end as the whole active day", () => {
    const allDay: Hours = { start: "00:00", end: "00:00", days: ["fri"] };
    expect(isWithinHours(friday(3), allDay)).toBe(true);
    expect(isWithinHours(new Date(2026, 10, 7, 3), allDay)).toBe(false);
  });
});

describe("currentEnd", () => {
  it("returns today's end during hours", () => {
    expect(currentEnd(friday(10), OFFICE)).toBe(friday(18).getTime());
  });

  it("returns null outside hours and for all-day hours", () => {
    expect(currentEnd(friday(19), OFFICE)).toBeNull();
    const allDay: Hours = { start: "00:00", end: "00:00", days: ALL_DAYS };
    expect(currentEnd(friday(10), allDay)).toBeNull();
  });

  it("handles hours past midnight", () => {
    const night: Hours = { start: "22:00", end: "02:00", days: ALL_DAYS };
    expect(currentEnd(friday(23), night)).toBe(
      new Date(2026, 10, 7, 2).getTime(),
    );
    expect(currentEnd(friday(1), night)).toBe(friday(2).getTime());
  });
});

describe("nextStart", () => {
  it("returns today's start before hours begin", () => {
    expect(nextStart(friday(8), OFFICE)).toBe(friday(9).getTime());
  });

  it("returns the next day's start after hours end", () => {
    expect(nextStart(friday(19), OFFICE)).toBe(
      new Date(2026, 10, 7, 9).getTime(),
    );
  });

  it("skips inactive days", () => {
    expect(nextStart(friday(19), { ...OFFICE, days: ["mon"] })).toBe(
      new Date(2026, 10, 9, 9).getTime(),
    );
  });

  it("returns null when no days are active", () => {
    expect(nextStart(friday(19), { ...OFFICE, days: [] })).toBeNull();
  });
});
