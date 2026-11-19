import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSchedule, formatDays, isValidTimeZone, lastOccurrence, parseDays, parseTime } from './schedule';

const at = (iso: string) => new Date(iso).getTime();

test('parses weekdays from storage and from forms, dropping anything else', () => {
    assert.deepEqual(parseDays('5,1,3'), [1, 3, 5]);
    assert.deepEqual(parseDays(['7', '2', '2', '9', 'x']), [2, 7]);
    assert.deepEqual(parseDays('4'), [4]);
    assert.deepEqual(parseDays(undefined), []);
    assert.equal(formatDays([3, 1, 1]), '1,3');
});

test('accepts only 24-hour HH:MM times and real time zones', () => {
    assert.equal(parseTime('08:05'), '08:05');
    assert.equal(parseTime('23:59'), '23:59');
    assert.equal(parseTime('24:00'), null);
    assert.equal(parseTime('8:05'), null);
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test('describes a schedule', () => {
    assert.equal(describeSchedule({ days: [1, 2, 3, 4, 5, 6, 7], time: '08:00' }), 'Every day at 08:00');
    assert.equal(describeSchedule({ days: [1, 3, 5], time: '18:30' }), 'Mon, Wed, Fri at 18:30');
    assert.equal(describeSchedule({ days: [], time: '08:00' }), 'Never');
});

test('finds the most recent scheduled moment in the account\'s time zone', () => {
    const monWedAt8 = { days: [1, 3], time: '08:00' };
    // Wednesday 2026-11-18, 09:00 in Berlin (UTC+1): this morning's 08:00.
    assert.equal(lastOccurrence(monWedAt8, 'Europe/Berlin', at('2026-11-18T08:00:00Z')), at('2026-11-18T07:00:00Z'));
    // Wednesday 07:30 in Berlin: not yet - Monday's.
    assert.equal(lastOccurrence(monWedAt8, 'Europe/Berlin', at('2026-11-18T06:30:00Z')), at('2026-11-16T07:00:00Z'));
    // Exactly at the moment counts.
    assert.equal(lastOccurrence(monWedAt8, 'Europe/Berlin', at('2026-11-18T07:00:00Z')), at('2026-11-18T07:00:00Z'));
    // The same instant is still Tuesday in New York: Monday's 08:00 there.
    assert.equal(lastOccurrence(monWedAt8, 'America/New_York', at('2026-11-18T04:00:00Z')), at('2026-11-16T13:00:00Z'));
    assert.equal(lastOccurrence({ days: [], time: '08:00' }, 'Europe/Berlin', at('2026-11-18T08:00:00Z')), null);
});

test('keeps the wall-clock time across daylight saving changes', () => {
    const sundaysAt8 = { days: [7], time: '08:00' };
    // Berlin switches to summer time on 2026-03-29: 08:00 is 06:00 UTC that
    // day, 07:00 UTC the Sunday before.
    assert.equal(lastOccurrence(sundaysAt8, 'Europe/Berlin', at('2026-03-29T12:00:00Z')), at('2026-03-29T06:00:00Z'));
    assert.equal(lastOccurrence(sundaysAt8, 'Europe/Berlin', at('2026-03-23T12:00:00Z')), at('2026-03-22T07:00:00Z'));
    // 02:30 doesn't exist that day in Berlin: it runs just after the jump.
    const gap = lastOccurrence({ days: [7], time: '02:30' }, 'Europe/Berlin', at('2026-03-29T12:00:00Z'))!;
    assert.ok(gap >= at('2026-03-29T01:00:00Z') && gap <= at('2026-03-29T01:30:00Z'), new Date(gap).toISOString());
});
