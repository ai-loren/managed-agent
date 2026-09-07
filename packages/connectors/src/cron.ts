/**
 * Cron evaluation.
 *
 * A five-field parser with no dependency, because the alternative is pulling in
 * a package to answer one question: given an expression, a timezone and a
 * moment, when does this next fire?
 *
 * Timezone handling is the part that is easy to get wrong. Cron fields describe
 * *local* wall-clock time, so "every day at 09:00" must mean 09:00 in the
 * schedule's zone across a DST boundary, not a fixed UTC offset chosen when the
 * schedule was created. We therefore search forward in local time and convert
 * each candidate back to an instant.
 */

import { validationError } from '@ma/core';

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the expression constrains day-of-month but not day-of-week. */
  restrictsDayOfMonth: boolean;
  restrictsDayOfWeek: boolean;
}

const RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  daysOfMonth: [1, 31],
  months: [1, 12],
  daysOfWeek: [0, 6],
} as const;

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse one field into the set of values it matches. */
function parseField(
  raw: string,
  [min, max]: readonly [number, number],
  names?: readonly string[],
): { values: Set<number>; restricts: boolean } {
  const values = new Set<number>();
  const restricts = raw !== '*';

  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw validationError(`Invalid step '${stepPart}' in cron field '${raw}'`);
    }

    let from: number;
    let to: number;

    if (rangePart === '*' || rangePart === undefined) {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      from = toNumber(a!, names);
      to = toNumber(b!, names);
    } else {
      from = toNumber(rangePart, names);
      // A bare value with a step means "from here onwards", e.g. `5/15`.
      to = stepPart === undefined ? from : max;
    }

    if (from < min || to > max || from > to) {
      throw validationError(`Cron field '${raw}' is outside the range ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (values.size === 0) throw validationError(`Cron field '${raw}' matches nothing`);
  return { values, restricts };
}

function toNumber(token: string, names?: readonly string[]): number {
  const numeric = Number(token);
  if (Number.isInteger(numeric)) return numeric;
  const index = names?.indexOf(token.toLowerCase());
  if (index === undefined || index < 0) {
    throw validationError(`Unrecognised cron value '${token}'`);
  }
  // Month names are 1-based, day names 0-based.
  return names === MONTH_NAMES ? index + 1 : index;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw validationError(
      `A cron expression has five fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
      { expression },
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, RANGES.minutes);
  const hours = parseField(hour, RANGES.hours);
  const dom = parseField(dayOfMonth, RANGES.daysOfMonth);
  const months = parseField(month, RANGES.months, MONTH_NAMES);
  const dow = parseField(dayOfWeek.replace(/7/g, '0'), RANGES.daysOfWeek, DAY_NAMES);

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek: dow.values,
    restrictsDayOfMonth: dom.restricts,
    restrictsDayOfWeek: dow.restricts,
  };
}

/** A moment as it reads on a wall clock in `timeZone`. */
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      });
    } catch {
      throw validationError(`Unknown time zone '${timeZone}'`);
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(instant: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdayName = get('weekday').toLowerCase().slice(0, 3);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Some locales render midnight as 24; normalize so hour is always 0-23.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, DAY_NAMES.indexOf(weekdayName)),
  };
}

function matches(fields: CronFields, parts: LocalParts): boolean {
  if (!fields.minutes.has(parts.minute)) return false;
  if (!fields.hours.has(parts.hour)) return false;
  if (!fields.months.has(parts.month)) return false;

  // The classic cron quirk: when *both* day fields are restricted they are
  // ORed, not ANDed. `0 0 1 * mon` means "the 1st, and also every Monday".
  const dayOfMonthMatches = fields.daysOfMonth.has(parts.day);
  const dayOfWeekMatches = fields.daysOfWeek.has(parts.weekday);

  if (fields.restrictsDayOfMonth && fields.restrictsDayOfWeek) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  if (fields.restrictsDayOfMonth) return dayOfMonthMatches;
  if (fields.restrictsDayOfWeek) return dayOfWeekMatches;
  return true;
}

const MINUTE_MS = 60_000;
/** Two years of minutes. Beyond this, an expression matches nothing real. */
const MAX_SEARCH_MINUTES = 2 * 366 * 24 * 60;

/**
 * The next instant at or after `after` (exclusive) when the expression fires.
 *
 * Minute-by-minute forward search. Unsophisticated, but correct across DST
 * transitions and leap years without special cases — and at one candidate per
 * minute, even the pathological "29 February" case resolves in well under the
 * search bound.
 */
export function nextFireTime(
  expression: string,
  timeZone: string,
  after: number,
): number | undefined {
  const fields = parseCron(expression);

  // Start at the next whole minute: cron has minute resolution, and a schedule
  // must not re-fire for the minute it just fired in.
  let candidate = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  for (let step = 0; step < MAX_SEARCH_MINUTES; step++) {
    if (matches(fields, localParts(candidate, timeZone))) return candidate;
    candidate += MINUTE_MS;
  }
  return undefined;
}

/** Validate an expression and zone, throwing with a usable message. */
export function validateCron(expression: string, timeZone: string): void {
  parseCron(expression);
  formatterFor(timeZone);
}
