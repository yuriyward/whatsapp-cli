import { usage } from "./errors.ts";

export interface Range {
  since: Date | undefined;
  until: Date;
  timezone: string;
}

function zone(tz: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: tz,
      year: "numeric",
    });
  } catch {
    throw usage(`--timezone ${JSON.stringify(tz)} is not an IANA zone such as Europe/Warsaw`);
  }
}
function parts(date: Date, tz: string) {
  const p = Object.fromEntries(zone(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), month: Number(p.month), second: Number(p.second), year: Number(p.year) };
}
/** Milliseconds the zone is ahead of UTC at this instant. */
function offset(date: Date, tz: string) {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
/** Local midnight of a calendar date in the zone. */
function midnight(year: number, month: number, day: number, tz: string) {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - offset(new Date(guess), tz);
  t = guess - offset(new Date(t), tz);
  return new Date(t);
}

/** `all`, `today`, `Nd` (rolling days), `YYYY-MM-DD` (calendar, in the zone) or an ISO timestamp with offset. */
export function parseDate(value: string, tz: string, now: Date, flag: string): Date | undefined {
  if (value === "all" && flag === "since") {
    return undefined;
  }
  if (value === "today") {
    const p = parts(now, tz);
    return midnight(p.year, p.month, p.day, tz);
  }
  const rolling = /^([1-9][0-9]{0,3})d$/.exec(value);
  if (rolling) {
    return new Date(now.getTime() - Number(rolling[1]) * 86_400_000);
  }
  const day = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (day) {
    return midnight(Number(day[1]), Number(day[2]), Number(day[3]), tz);
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) && !Number.isNaN(Date.parse(value))) {
    return new Date(value);
  }
  throw usage(`--${flag} must be ${flag === "since" ? "all, " : ""}today, Nd, YYYY-MM-DD or an ISO timestamp with offset`);
}

export function range(since: string, until: string | undefined, tz: string, now: Date): Range {
  zone(tz);
  const start = parseDate(since, tz, now, "since");
  const end = until === undefined ? now : (parseDate(until, tz, now, "until") as Date);
  if (start && start >= end) {
    throw usage("--since must be before --until");
  }
  return { since: start, timezone: tz, until: end };
}

/** wacli bounds are exclusive whole seconds (`ts > after`, `ts < before`); this keeps [since, until). */
export function wacliBounds(r: Range) {
  const args: string[] = [];
  if (r.since) {
    args.push(`--after=${new Date(Math.ceil(r.since.getTime() / 1000) * 1000 - 1000).toISOString().replace(".000Z", "Z")}`);
  }
  args.push(`--before=${new Date(Math.ceil(r.until.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z")}`);
  return args;
}

export const iso = (d: Date | undefined) => (d ? d.toISOString() : null);

/** `YYYY-MM-DD HH:MM` in the zone, for compact text. */
export function local(value: string, tz: string) {
  const p = parts(new Date(value), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
