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
  // Day-of-week input permits 7 (Sunday alias); it is folded to 0 after parsing,
  // so the effective range of stored values is 0-6.
  daysOfWeekInput: [0, 7],
} as const;

/** Fold 7 (a Sunday alias) into 0, leaving every other day untouched. */
function foldSunday(values: Set<number>): Set<number> {
  if (!values.has(7)) return values;
  const folded = new Set(values);
  folded.delete(7);
  folded.add(0);
  return folded;
}

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
  // Day-of-week accepts 7 as an alias for Sunday (0). It is parsed against the
  // extended range 0-7 and any 7 is then folded to 0, so `0-7` is the whole week
  // and `*/7` is a legal step — unlike a raw `replace(/7/g, '0')`, which rewrote
  // every 7 in the field (collapsing `0-7` to only Sunday, breaking `*/7`).
  const dowRaw = parseField(dayOfWeek, RANGES.daysOfWeekInput, DAY_NAMES);
  const dow = {
    values: foldSunday(dowRaw.values),
    restricts: dowRaw.restricts,
  };

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
const HOUR_MS = 60 * MINUTE_MS;
/** Two years of minutes. Beyond this, an expression matches nothing real. */
const MAX_SEARCH_MINUTES = 2 * 366 * 24 * 60;

/**
 * The next instant at or after `after` (exclusive) when the expression fires.
 *
 * Minute-by-minute forward search over absolute time, matching against local
 * wall-clock parts. Unsophisticated, and correct across leap years and both DST
 * transitions without special cases in the matcher itself.
 *
 * Spring-forward needs no handling: the local hour simply never occurs, so no
 * candidate matches and the schedule skips a day — which is what an operator
 * expects from a job at 02:30 on a day with no 02:30.
 *
 * Fall-back does. An hour repeats, so two distinct instants share one local
 * wall clock and both match — a nightly job at 01:30 fired twice, once in BST
 * and once in GMT. Nothing downstream suppressed it either: the receipt's
 * dedupe key is `${connectorId}:${firedAt}` and the two instants differ.
 *
 * The rule is that a cron expression names a wall-clock time, and a wall-clock
 * time that occurs twice is still one scheduled run. `#firedThisLocalMinute`
 * below therefore rejects a candidate whose local minute equals the one
 * immediately before it in absolute terms — the second pass over a repeated
 * hour — while leaving every ordinary day untouched.
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
    const parts = localParts(candidate, timeZone);
    if (matches(fields, parts) && !isRepeatedLocalMinute(candidate, timeZone, parts)) {
      return candidate;
    }
    candidate += MINUTE_MS;
  }
  return undefined;
}

/**
 * Whether this instant is the *second* occurrence of its local minute.
 *
 * True only during a fall-back repeat: one hour earlier in absolute time lands
 * on the same wall clock. On any ordinary day an hour earlier is a different
 * local hour, so this is false and costs one extra formatter call per matched
 * candidate — not per candidate examined.
 */
function isRepeatedLocalMinute(
  instant: number,
  timeZone: string,
  parts: LocalParts,
): boolean {
  const earlier = localParts(instant - HOUR_MS, timeZone);
  return (
    earlier.minute === parts.minute &&
    earlier.hour === parts.hour &&
    earlier.day === parts.day &&
    earlier.month === parts.month &&
    earlier.year === parts.year
  );
}

/** Validate an expression and zone, throwing with a usable message. */
export function validateCron(expression: string, timeZone: string): void {
  parseCron(expression);
  formatterFor(timeZone);
}
