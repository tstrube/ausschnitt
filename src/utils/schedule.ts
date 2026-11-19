// New-page check schedules: weekdays (ISO, 1 = Monday ... 7 = Sunday) and
// one time of day, in the server's time zone (see newPageNotifier.ts).

// `short` for the seven toggles side by side on a phone.
export const WEEKDAYS: { day: number; label: string; short: string }[] = [
    { day: 1, label: 'Mon', short: 'Mo' },
    { day: 2, label: 'Tue', short: 'Tu' },
    { day: 3, label: 'Wed', short: 'We' },
    { day: 4, label: 'Thu', short: 'Th' },
    { day: 5, label: 'Fri', short: 'Fr' },
    { day: 6, label: 'Sat', short: 'Sa' },
    { day: 7, label: 'Sun', short: 'Su' }
];

export interface Schedule {
    days: number[];
    time: string;
}

// Weekdays as stored ("1,3,5") or as a form sends them (one value, or an
// array for several checkboxes of the same name). Unknown values are
// dropped; none at all means "never".
export function parseDays(raw: unknown): number[] {
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
    const days = values.map(v => Number(v)).filter(d => Number.isInteger(d) && d >= 1 && d <= 7);
    return [...new Set(days)].sort((a, b) => a - b);
}

export function formatDays(days: number[]): string {
    return parseDays(days.map(String)).join(',');
}

// "HH:MM", 24-hour, or null.
export function parseTime(raw: unknown): string | null {
    return typeof raw === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : null;
}

export function isValidTimeZone(raw: unknown): raw is string {
    if (typeof raw !== 'string' || !raw) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: raw });
        return true;
    } catch {
        return false;
    }
}

// The server's time zone - the TZ environment variable (docker-compose.yml),
// else the system's, UTC in a container without one.
export function serverTimeZone(): string {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : 'UTC';
}

// "Every day at 08:00", "Mon, Wed, Fri at 08:00", or "Never".
export function describeSchedule(schedule: Schedule): string {
    if (!schedule.days.length) return 'Never';
    const when = schedule.days.length === 7 ? 'Every day'
        : schedule.days.map(d => WEEKDAYS[d - 1].label).join(', ');
    return `${when} at ${schedule.time}`;
}

const WEEKDAY_NUMBERS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// The wall-clock date, time and weekday of an instant in a time zone.
function zonedParts(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
        weekday: 'short'
    }).formatToParts(new Date(instant));
    const get = (type: string) => parts.find(p => p.type === type)!.value;
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour: Number(get('hour')),
        minute: Number(get('minute')),
        weekday: WEEKDAY_NUMBERS[get('weekday')]
    };
}

// The instant a wall-clock time on a date has in a time zone. A time that
// doesn't exist that day (skipped by a daylight saving change) lands just
// after the gap; one that exists twice, on the first.
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const offset = (instant: number) => {
        const p = zonedParts(instant, timeZone);
        return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant / 60000) * 60000;
    };
    const first = wall - offset(wall);
    return wall - offset(first);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The most recent scheduled moment at or before `now`, or null for a
// schedule without weekdays.
export function lastOccurrence(schedule: Schedule, timeZone: string, now: number): number | null {
    if (!schedule.days.length) return null;
    const [hour, minute] = schedule.time.split(':').map(Number);
    for (let back = 0; back <= 7; back++) {
        const date = zonedParts(now - back * DAY_MS, timeZone);
        if (!schedule.days.includes(date.weekday)) continue;
        const instant = zonedInstant(date.year, date.month, date.day, hour, minute, timeZone);
        if (instant <= now) return instant;
    }
    return null;
}
