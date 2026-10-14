import { AppError } from "@/lib/http/app-error";

import type { DashboardPreset, DashboardQuery } from "./contracts";

export type ResolvedDashboardRange = {
  start: string | null;
  end: string;
  comparison: { start: string; end: string } | null;
};

type DateParts = { year: number; month: number; day: number };

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayMilliseconds = 86_400_000;

function rangeInvalid(): never {
  throw new AppError(
    "DASHBOARD_DATE_RANGE_INVALID",
    400,
    "Dashboard date range is invalid",
  );
}

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseDate(value: string): DateParts {
  const match = isoDatePattern.exec(value);
  if (!match) rangeInvalid();
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (
    parts.year < 1 ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInMonth(parts.year, parts.month)
  ) {
    rangeInvalid();
  }
  return parts;
}

function formatDate(parts: DateParts) {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function toEpochMilliseconds(value: string) {
  const parts = parseDate(value);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime();
}

function fromEpochMilliseconds(value: number) {
  const date = new Date(value);
  return formatDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

function addDays(value: string, amount: number) {
  return fromEpochMilliseconds(toEpochMilliseconds(value) + amount * dayMilliseconds);
}

function addYears(value: string, amount: number) {
  const parts = parseDate(value);
  const year = parts.year + amount;
  if (year < 1 || year > 9999) rangeInvalid();
  return formatDate({
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  });
}

export function inclusiveDayCount(start: string, end: string) {
  const difference = toEpochMilliseconds(end) - toEpochMilliseconds(start);
  if (difference < 0) rangeInvalid();
  return Math.round(difference / dayMilliseconds) + 1;
}

export function resolveRange(
  query: Pick<DashboardQuery, "range" | "start" | "end">,
  today: string,
): ResolvedDashboardRange {
  parseDate(today);

  if (query.range === "all_time") {
    return { start: null, end: today, comparison: null };
  }
  if (query.range === "current_year") {
    const year = parseDate(today).year;
    return {
      start: `${year.toString().padStart(4, "0")}-01-01`,
      end: today,
      comparison: {
        start: `${(year - 1).toString().padStart(4, "0")}-01-01`,
        end: addYears(today, -1),
      },
    };
  }
  if (query.range === "last_12_months") {
    const start = addDays(addYears(today, -1), 1);
    const comparisonEnd = addDays(start, -1);
    return {
      start,
      end: today,
      comparison: {
        start: addDays(addYears(comparisonEnd, -1), 1),
        end: comparisonEnd,
      },
    };
  }
  if (!query.start || !query.end || query.end > today) rangeInvalid();

  const days = inclusiveDayCount(query.start, query.end);
  const comparisonEnd = addDays(query.start, -1);
  return {
    start: query.start,
    end: query.end,
    comparison: {
      start: addDays(comparisonEnd, -(days - 1)),
      end: comparisonEnd,
    },
  };
}

export function resolveTrendGranularity(
  range: { start: string; end: string },
  preset: DashboardPreset,
): "day" | "month" | "year" {
  if (preset === "current_year" || preset === "last_12_months") {
    return "month";
  }
  const days = inclusiveDayCount(range.start, range.end);
  if (preset === "custom" && days <= 62) return "day";
  return days <= 731 ? "month" : "year";
}
