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
  // Only a canonical run of decimal digits is a numeric cron token. `Number()`
  // is far too lenient here: `Number('')` is 0, `Number('0x1f')` is 31, and
  // `Number('5.0')`/`Number(' 5 ')` also pass `Number.isInteger`. A trailing or
  // doubled comma (a common typo, e.g. `5,`) splits to an empty token that would
  // otherwise be read as minute 0 — silently adding a fire the author never
  // wrote. Reject anything non-canonical and fall through to the name lookup.
  if (/^\d+$/.test(token)) return Number(token);
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
/**
 * How far ahead to search for the next fire.
 *
 * Must exceed the longest gap between two consecutive fires of any *valid* cron,
 * or a legitimately-sparse schedule would look unfireable. The sparsest fireable
 * cron is `0 0 29 2 *` (every leap-day Feb 29), and the leap rule skips a century
 * year (2100 is not a leap year), so consecutive Feb 29s can be **8 years** apart
 * (2096 → 2104). Ten years covers that with margin. Beyond this an expression
 * genuinely names no real time (Feb 30, Apr 31, …), which the caller treats as
 * unfireable.
 *
 * This horizon is affordable only because the search is day-first: whole
 * non-matching days are skipped by a single date check, so reaching ten years is
 * ~3,650 day checks, not ~5.3M minute checks. A minute-by-minute scan at this
 * horizon would be seconds of CPU per unfireable schedule per tick.
 */
const MAX_SEARCH_DAYS = 10 * 366;

/**
 * Whether a day *could* contain a matching minute — the date fields only.
 *
 * This is the fast skip: if the day's month and (ORed) day-of-month/day-of-week
 * do not match, no minute on that day can match, so the whole day is skipped
 * without a 1,440-minute inner scan. Mirrors the day-level half of `matches`.
 */
function dayCouldMatch(fields: CronFields, parts: LocalParts): boolean {
  if (!fields.months.has(parts.month)) return false;
  const dayOfMonthMatches = fields.daysOfMonth.has(parts.day);
  const dayOfWeekMatches = fields.daysOfWeek.has(parts.weekday);
  if (fields.restrictsDayOfMonth && fields.restrictsDayOfWeek) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  if (fields.restrictsDayOfMonth) return dayOfMonthMatches;
  if (fields.restrictsDayOfWeek) return dayOfWeekMatches;
  return true;
}

/**
 * The next instant at or after `after` (exclusive) when the expression fires,
 * or `undefined` when it names no real time within the search horizon (a day
 * that never exists, like Feb 30).
 *
 * Day-first forward search: skip whole non-matching days by a single date check,
 * then minute-scan only a day whose date fields match. This keeps the search
 * cheap enough to look years ahead — necessary so a legitimately-sparse cron
 * (every Feb 29) resolves rather than looking unfireable — while a genuinely
 * impossible date is rejected after ~a few thousand day checks, not millions of
 * minute checks.
 *
 * The per-minute matching is unchanged and still exact across leap years and both
 * DST transitions:
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
 * time that occurs twice is still one scheduled run. `isRepeatedLocalMinute`
 * therefore rejects a candidate whose local minute equals the one immediately
 * before it in absolute terms — the second pass over a repeated hour — while
 * leaving every ordinary day untouched.
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

  for (let day = 0; day < MAX_SEARCH_DAYS; day++) {
    const dayParts = localParts(candidate, timeZone);

    if (dayCouldMatch(fields, dayParts)) {
      // Minute-scan this day only. Walk minute by minute while still on the same
      // local calendar day, applying the full (exact) matcher. Crossing DST is
      // handled by re-reading local parts each minute, exactly as before.
      //
      // The cap is 26 hours of minutes, not 24: a fall-back day is a 25-hour
      // civil day (the clocks repeat an hour), so local 23:59 sits ~1499 minutes
      // after local 00:00, past a 24h cap. A 24h cap silently skipped any
      // late-evening fire on a fall-back day (a nightly `59 23 * * *` missed its
      // run twice a year). The `break` on the day/month rollover still stops the
      // scan at the true civil-day boundary, so a normal day never over-scans;
      // the wider cap only matters on the long day.
      let minute = candidate;
      for (let step = 0; step < 26 * 60 + 2; step++) {
        const parts = localParts(minute, timeZone);
        if (parts.day !== dayParts.day || parts.month !== dayParts.month) break;
        if (matches(fields, parts) && !isRepeatedLocalMinute(minute, timeZone, parts)) {
          return minute;
        }
        minute += MINUTE_MS;
      }
    }

    // Advance to the start of the next local calendar day. Jump ~a day, then
    // snap back to local midnight so the next iteration's date check is on a
    // fresh day regardless of DST (a day is 23–25 hours across a transition).
    candidate = startOfNextLocalDay(candidate, timeZone);
  }
  return undefined;
}

/**
 * The first instant (to minute resolution) of the local calendar day after the
 * one `instant` falls in. Used to skip a whole non-matching day at once.
 *
 * Adds 26h to cross into the next civil day (enough to clear even a 25-hour
 * fall-back day), then walks back to that day's 00:00 local — robust across DST,
 * where the civil day is 23 or 25 hours long, because it anchors on the
 * wall-clock date rather than a fixed offset.
 */
function startOfNextLocalDay(instant: number, timeZone: string): number {
  const today = localParts(instant, timeZone);
  // 26h guarantees we land on the next civil day even at a 25h fall-back day.
  let probe = instant + 26 * HOUR_MS;
  // If we overshot past the immediate next day (only possible in pathological
  // zones), pull back to the earliest instant still on a later day.
  for (let i = 0; i < 48; i++) {
    const back = probe - HOUR_MS;
    const backParts = localParts(back, timeZone);
    if (backParts.day === today.day && backParts.month === today.month && backParts.year === today.year) {
      break;
    }
    probe = back;
  }
  // Snap to local midnight of that next day by walking back minute steps while
  // still after 00:00. Cheap: at most 60 minutes since we start near an hour edge.
  let midnight = probe;
  for (let i = 0; i < 24 * 60; i++) {
    const parts = localParts(midnight - MINUTE_MS, timeZone);
    const cur = localParts(midnight, timeZone);
    if (parts.day !== cur.day || parts.month !== cur.month || parts.year !== cur.year) break;
    if (cur.hour === 0 && cur.minute === 0) break;
    midnight -= MINUTE_MS;
  }
  return Math.floor(midnight / MINUTE_MS) * MINUTE_MS;
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
