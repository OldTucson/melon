import { AppError } from "@/lib/http/app-error";

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const invalidDate = (): never => {
  throw new AppError(
    "AUTHORIZATION_DATE_INVALID",
    400,
    "Authorization date is invalid",
  );
};

function isIsoCalendarDate(value: string) {
  const match = isoDatePattern.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = month === 2 && leapYear ? 29 : monthLengths[month - 1]!;
  return day <= maxDay;
}

export function currentDateInTimeZone(
  now = new Date(),
  timeZone = "Asia/Shanghai",
): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${value.year}-${value.month}-${value.day}`;
}

export function parseAuthorizedOn(
  input: string,
  today = currentDateInTimeZone(),
): string {
  if (!isIsoCalendarDate(input) || !isIsoCalendarDate(today)) invalidDate();
  if (input > today) invalidDate();
  return input;
}
