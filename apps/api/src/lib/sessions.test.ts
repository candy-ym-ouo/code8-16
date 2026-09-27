import { describe, expect, it } from 'vitest';
import {
  findConsecutiveBoundary,
  groupReadingSessions,
  localDateOf,
  normalizeGapMinutes,
  normalizeTimezone,
  previewBoundaryDecision,
  type SessionOverride,
  type SessionTrace
} from './sessions.js';
import { AppError } from './errors.js';

const UTC = 'UTC';
const SHANGHAI = 'Asia/Shanghai';

function trace(id: string, bookId: string, createdAt: string, type: SessionTrace['type'] = 'DOG_EAR'): SessionTrace {
  return { id, bookId, type, createdAt: new Date(createdAt) };
}

function override(
  id: string,
  bookId: string,
  kind: SessionOverride['kind'],
  leftTraceId: string,
  rightTraceId: string,
  createdAt = '2026-09-01T00:00:00.000Z'
): SessionOverride {
  return { id, bookId, kind, leftTraceId, rightTraceId, createdAt: new Date(createdAt), revokedAt: null };
}

describe('localDateOf', () => {
  it('assigns the same instant to different local days across timezones', () => {
    const instant = new Date('2026-09-26T17:30:00.000Z');
    expect(localDateOf(instant, UTC)).toBe('2026-09-26');
    expect(localDateOf(instant, SHANGHAI)).toBe('2026-09-27');
  });
});

describe('groupReadingSessions', () => {
  it('groups same-book traces of one local day within the gap', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:20:00.000Z', 'ANNOTATION'),
      trace('t3', book, '2026-09-26T10:40:00.000Z', 'REREAD_MARK')
    ];
    const sessions = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.traceIds).toEqual(['t1', 't2', 't3']);
    expect(sessions[0]!.startedAt.toISOString()).toBe('2026-09-26T10:00:00.000Z');
    expect(sessions[0]!.endedAt.toISOString()).toBe('2026-09-26T10:40:00.000Z');
    expect(sessions[0]!.date).toBe('2026-09-26');
    expect(sessions[0]!.spansMidnight).toBe(false);
  });

  it('splits when the gap between consecutive traces is exceeded', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:31:00.000Z')
    ];
    const sessions = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.traceIds)).toEqual([['t1'], ['t2']]);
  });

  it('keeps traces at exactly the gap boundary together', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:30:00.000Z')
    ];
    const sessions = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(1);
  });

  it('splits across local midnight in UTC, and recalculates as one day in Shanghai', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T23:50:00.000Z'),
      trace('t2', book, '2026-09-27T00:10:00.000Z')
    ];
    const inUtc = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    expect(inUtc).toHaveLength(2);
    expect(inUtc.map((session) => session.date)).toEqual(['2026-09-26', '2026-09-27']);

    const inShanghai = groupReadingSessions(traces, [], { timezone: SHANGHAI, gapMinutes: 30 });
    expect(inShanghai).toHaveLength(1);
    expect(inShanghai[0]!.date).toBe('2026-09-27');
    expect(inShanghai[0]!.spansMidnight).toBe(false);
  });

  it('marks a merged cross-midnight session as spanning midnight', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T23:50:00.000Z'),
      trace('t2', book, '2026-09-27T00:05:00.000Z')
    ];
    const overrides = [override('o1', book, 'MERGE', 't1', 't2')];
    const sessions = groupReadingSessions(traces, overrides, { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.localDates).toEqual(['2026-09-26', '2026-09-27']);
    expect(sessions[0]!.spansMidnight).toBe(true);
    expect(sessions[0]!.appliedOverrides).toEqual([{ id: 'o1', kind: 'MERGE' }]);
    // 时间戳没有被移动
    expect(sessions[0]!.startedAt.toISOString()).toBe('2026-09-26T23:50:00.000Z');
    expect(sessions[0]!.endedAt.toISOString()).toBe('2026-09-27T00:05:00.000Z');
  });

  it('forces a split between traces that would otherwise stay together', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:05:00.000Z')
    ];
    const overrides = [override('o1', book, 'SPLIT', 't1', 't2')];
    const sessions = groupReadingSessions(traces, overrides, { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(2);
  });

  it('ignores revoked overrides', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T23:50:00.000Z'),
      trace('t2', book, '2026-09-27T00:05:00.000Z')
    ];
    const revoked = override('o1', book, 'MERGE', 't1', 't2');
    revoked.revokedAt = new Date('2026-09-27T01:00:00.000Z');
    const sessions = groupReadingSessions(traces, [revoked], { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(2);
  });

  it('lets the latest non-revoked override win when merge and split collide', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:05:00.000Z')
    ];
    const overrides = [
      override('split', book, 'SPLIT', 't1', 't2', '2026-09-26T12:00:00.000Z'),
      override('merge', book, 'MERGE', 't1', 't2', '2026-09-26T13:00:00.000Z')
    ];
    const sessions = groupReadingSessions(traces, overrides, { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.appliedOverrides).toEqual([{ id: 'merge', kind: 'MERGE' }]);
  });

  it('never merges traces of different books even inside the gap', () => {
    const traces = [
      trace('t1', '00000000-0000-0000-0000-000000000001', '2026-09-26T10:00:00.000Z'),
      trace('t2', '00000000-0000-0000-0000-000000000002', '2026-09-26T10:01:00.000Z')
    ];
    const sessions = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    expect(sessions).toHaveLength(2);
  });

  it('produces stable session ids from members and keeps input timestamps untouched', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:20:00.000Z')
    ];
    const first = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    const second = groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 });
    expect(first[0]!.id).toBe(second[0]!.id);
    expect(traces[0]!.createdAt.toISOString()).toBe('2026-09-26T10:00:00.000Z');
  });

  it('recalculates purely from parameters: larger gap joins, smaller gap splits', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:45:00.000Z')
    ];
    expect(groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 30 })).toHaveLength(2);
    expect(groupReadingSessions(traces, [], { timezone: UTC, gapMinutes: 60 })).toHaveLength(1);
  });
});

describe('findConsecutiveBoundary', () => {
  it('only accepts traces that are consecutive within one book', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [
      trace('t1', book, '2026-09-26T10:00:00.000Z'),
      trace('t2', book, '2026-09-26T10:05:00.000Z'),
      trace('t3', book, '2026-09-26T10:10:00.000Z')
    ];
    expect(findConsecutiveBoundary(traces, book, 't1', 't2')).not.toBeNull();
    expect(findConsecutiveBoundary(traces, book, 't1', 't3')).toBeNull();
  });
});

describe('previewBoundaryDecision', () => {
  it('reports when a boundary is not applicable (deleted/non-consecutive traces)', () => {
    const book = '00000000-0000-0000-0000-000000000001';
    const traces = [trace('t1', book, '2026-09-26T10:00:00.000Z')];
    const preview = previewBoundaryDecision(traces, [], { timezone: UTC, gapMinutes: 30 }, book, 't1', 'missing');
    expect(preview).toEqual({ joined: false, applicable: false });
  });
});

describe('parameter validation', () => {
  it('rejects unknown timezones and out-of-range gaps', () => {
    expect(() => normalizeTimezone('Not/AZone')).toThrow(AppError);
    expect(() => normalizeGapMinutes(0)).toThrow(AppError);
    expect(() => normalizeGapMinutes(2000)).toThrow(AppError);
  });

  it('accepts valid values and defaults', () => {
    expect(normalizeTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(normalizeTimezone(undefined)).toBe('UTC');
    expect(normalizeGapMinutes(undefined)).toBe(30);
    expect(normalizeGapMinutes(1440)).toBe(1440);
  });
});
