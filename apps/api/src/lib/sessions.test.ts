import { describe, expect, it } from 'vitest';
import {
  groupReadingSessions,
  localCalendarDay,
  locateEdge,
  sortTraces,
  type SessionOverrideInput,
  type SessionTraceInput
} from './sessions.js';

const TZ_SHANGHAI = 'Asia/Shanghai'; // UTC+8，无夏令时
const TZ_LOS_ANGELES = 'America/Los_Angeles'; // 测试夏令时切换

function trace(id: string, bookId: string, at: string, type: SessionTraceInput['type'] = 'DOG_EAR'): SessionTraceInput {
  return { id, bookId, type, createdAt: new Date(at) };
}

function override(
  id: string,
  bookId: string,
  kind: SessionOverrideInput['kind'],
  previousTraceId: string,
  nextTraceId: string
): SessionOverrideInput {
  return { id, bookId, kind, previousTraceId, nextTraceId, createdAt: new Date('2026-09-20T00:00:00.000Z') };
}

describe('localCalendarDay', () => {
  it('maps UTC instants to local dates by time zone', () => {
    // 2026-01-01 17:00 UTC = 2026-01-02 01:00 Shanghai
    expect(localCalendarDay(new Date('2026-01-01T17:00:00.000Z'), TZ_SHANGHAI)).toBe('2026-01-02');
    expect(localCalendarDay(new Date('2026-01-01T15:59:59.000Z'), TZ_SHANGHAI)).toBe('2026-01-01');
  });

  it('accepts an unknown IANA zone by rejecting it', () => {
    expect(() => localCalendarDay(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('groupReadingSessions basic segmentation', () => {
  const bookId = '11111111-1111-4111-8111-111111111111';

  it('groups same-day traces within the gap into one continuous segment', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T12:00:00.000Z'),
      trace('b', bookId, '2026-09-20T12:30:00.000Z', 'ANNOTATION'),
      trace('c', bookId, '2026-09-20T13:00:00.000Z', 'REREAD_MARK')
    ];
    const result = groupReadingSessions(traces, [], { timeZone: TZ_SHANGHAI, gapMinutes: 90 });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    expect(session.traceIds).toEqual(['a', 'b', 'c']);
    expect(session.startedAt).toEqual(traces[0]!.createdAt);
    expect(session.endedAt).toEqual(traces[2]!.createdAt);
    expect(session.traceTypes).toEqual({ DOG_EAR: 1, ANNOTATION: 1, REREAD_MARK: 1 });
    expect(session.crossedLocalMidnight).toBe(false);
    expect(session.localDate).toBe('2026-09-20');
  });

  it('splits at a gap longer than the configured maximum', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T01:00:00.000Z'),
      trace('b', bookId, '2026-09-20T02:31:00.000Z'), // 距 a 91 分钟：断开
      trace('c', bookId, '2026-09-20T04:02:00.000Z') // 距 b 91 分钟：断开
    ];
    const result90 = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(result90.sessions).toHaveLength(3);

    const result120 = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 120 });
    expect(result120.sessions).toHaveLength(1);
  });

  it('uses inclusive gap boundary', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T00:00:00.000Z'),
      trace('b', bookId, '2026-09-20T01:30:00.000Z')
    ];
    const result = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(result.sessions).toHaveLength(1);
  });

  it('groups by local calendar day even within the gap: crossing UTC midnight stays together in the same local day', () => {
    // 上海本地 09-21 07:30 -> 08:00，对应 UTC 09-20 23:30 -> 09-21 00:00
    const traces = [
      trace('a', bookId, '2026-09-20T23:30:00.000Z'),
      trace('b', bookId, '2026-09-21T00:00:00.000Z')
    ];
    const resultShanghai = groupReadingSessions(traces, [], { timeZone: TZ_SHANGHAI, gapMinutes: 90 });
    expect(resultShanghai.sessions).toHaveLength(1);
    expect(resultShanghai.sessions[0]!.localDate).toBe('2026-09-21');
    expect(resultShanghai.sessions[0]!.crossedLocalMidnight).toBe(false);

    // 同样的 UTC 时刻，UTC 视角下跨午夜 -> 两个片段
    const resultUtc = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(resultUtc.sessions).toHaveLength(2);
    expect(resultUtc.sessions.map((session) => session.localDate).sort()).toEqual(['2026-09-20', '2026-09-21']);
  });

  it('splits traces that cross local midnight even if within the gap', () => {
    // 上海本地 09-20 22:00 (UTC 14:00) -> 09-21 00:30 (UTC 16:30)，
    // 间隔 150 分钟、落在 240 分钟阈值内，但跨本地午夜 -> 两个片段
    const crossing = [
      trace('a', bookId, '2026-09-20T14:00:00.000Z'),
      trace('b', bookId, '2026-09-20T16:30:00.000Z')
    ];
    const result = groupReadingSessions(crossing, [], { timeZone: TZ_SHANGHAI, gapMinutes: 240 });
    expect(result.sessions).toHaveLength(2);
    // 片段按开始时间倒序返回
    expect(result.sessions.map((session) => session.localDate)).toEqual(['2026-09-21', '2026-09-20']);
    expect(result.sessions.map((session) => session.localDate).sort()).toEqual(['2026-09-20', '2026-09-21']);
  });
});

describe('groupReadingSessions time-zone recomputation', () => {
  const bookId = '22222222-2222-4222-8222-222222222222';
  // 本地阅读场景：上海 09-21 07:30 与 09-21 08:00（UTC 09-20 23:30 / 09-21 00:00）
  const traces = [
    trace('a', bookId, '2026-09-20T23:30:00.000Z'),
    trace('b', bookId, '2026-09-21T00:00:00.000Z')
  ];

  it('recomputes day buckets when the viewer time zone changes', () => {
    const shanghai = groupReadingSessions(traces, [], { timeZone: TZ_SHANGHAI, gapMinutes: 90 });
    expect(shanghai.sessions).toHaveLength(1);
    expect(shanghai.sessions[0]!.localDate).toBe('2026-09-21');

    const utc = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(utc.sessions).toHaveLength(2);
  });

  it('handles DST spring-forward and fall-back days', () => {
    // 2026-11-01 America/Los_Angeles 00:30 PDT (UTC 07:30) 与 01:30 PST (UTC 09:30) 同属本地 11-01
    const tracesDst = [
      trace('a', bookId, '2026-11-01T07:30:00.000Z'),
      trace('b', bookId, '2026-11-01T09:30:00.000Z')
    ];
    const result = groupReadingSessions(tracesDst, [], { timeZone: TZ_LOS_ANGELES, gapMinutes: 150 });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.localDate).toBe('2026-11-01');
  });

  it('produces identical keys and order for identical inputs (deterministic)', () => {
    const tracesMany = [
      trace('b', bookId, '2026-09-21T02:00:00.000Z'),
      trace('a', bookId, '2026-09-21T01:00:00.000Z'),
      trace('c', bookId, '2026-09-20T01:00:00.000Z')
    ];
    const first = groupReadingSessions(tracesMany, [], { timeZone: 'UTC', gapMinutes: 90 });
    const second = groupReadingSessions([...tracesMany].reverse(), [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(first.sessions.map((session) => session.key)).toEqual(second.sessions.map((session) => session.key));
  });
});

describe('groupReadingSessions overrides', () => {
  const bookId = '33333333-3333-4333-8333-333333333333';

  it('MERGE forces a segment across midnight and a large gap and flags crossedLocalMidnight', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T15:00:00.000Z'), // 上海 23:00
      trace('b', bookId, '2026-09-21T16:00:00.000Z') // 上海次日 00:00，间隔 25 小时
    ];
    const natural = groupReadingSessions(traces, [], { timeZone: TZ_SHANGHAI, gapMinutes: 90 });
    expect(natural.sessions).toHaveLength(2);

    const merged = groupReadingSessions(traces, [override('o1', bookId, 'MERGE', 'a', 'b')], {
      timeZone: TZ_SHANGHAI,
      gapMinutes: 90
    });
    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0]!.traceIds).toEqual(['a', 'b']);
    expect(merged.sessions[0]!.crossedLocalMidnight).toBe(true);
    expect(merged.sessions[0]!.edgeOverrides).toEqual([
      expect.objectContaining({ overrideId: 'o1', kind: 'MERGE' })
    ]);
  });

  it('SPLIT forces a break even when natural grouping would connect', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T01:00:00.000Z'),
      trace('b', bookId, '2026-09-20T01:10:00.000Z'),
      trace('c', bookId, '2026-09-20T01:20:00.000Z')
    ];
    const result = groupReadingSessions(traces, [override('o1', bookId, 'SPLIT', 'b', 'a')], {
      timeZone: 'UTC',
      gapMinutes: 90
    });
    expect(result.sessions).toHaveLength(2);
    // 覆盖允许反向存储（next/previous 对调），分组时按时间重排
    expect(result.sessions.map((session) => session.traceIds)).toEqual([['b', 'c'], ['a']]);
  });

  it('overrides are absolute: they survive a time zone change that regroups natural boundaries', () => {
    // 上海视角跨午夜本应拆开的两条，用户 MERGE；换到 UTC 视角后仍是一段
    const traces = [
      trace('a', bookId, '2026-09-20T14:00:00.000Z'), // 上海 22:00
      trace('b', bookId, '2026-09-20T16:30:00.000Z') // 上海次日 00:30
    ];
    const overrides = [override('o1', bookId, 'MERGE', 'a', 'b')];
    const shanghai = groupReadingSessions(traces, overrides, { timeZone: TZ_SHANGHAI, gapMinutes: 90 });
    const utc = groupReadingSessions(traces, overrides, { timeZone: 'UTC', gapMinutes: 90 });
    expect(shanghai.sessions).toHaveLength(1);
    expect(utc.sessions).toHaveLength(1);
    expect(utc.sessions[0]!.crossedLocalMidnight).toBe(false);
  });

  it('reports overrides whose traces are deleted or no longer adjacent as stale and ignores them', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T01:00:00.000Z'),
      trace('b', bookId, '2026-09-20T01:10:00.000Z'),
      trace('c', bookId, '2026-09-20T01:20:00.000Z')
    ];
    // SPLIT a-c：中间有 b，不再相邻 -> stale，自然分组保持一段
    const result = groupReadingSessions(traces, [override('o1', bookId, 'SPLIT', 'a', 'c')], {
      timeZone: 'UTC',
      gapMinutes: 90
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.staleOverrideIds).toEqual(['o1']);

    // 指向已删除痕迹
    const resultMissing = groupReadingSessions(traces, [override('o2', bookId, 'MERGE', 'a', 'z')], {
      timeZone: 'UTC',
      gapMinutes: 90
    });
    expect(resultMissing.sessions).toHaveLength(1);
    expect(resultMissing.staleOverrideIds).toEqual(['o2']);
  });

  it('never mutates trace timestamps: input Date objects stay untouched', () => {
    const a = trace('a', bookId, '2026-09-20T14:00:00.000Z');
    const b = trace('b', bookId, '2026-09-20T16:30:00.000Z');
    const snapshotA = new Date(a.createdAt);
    groupReadingSessions([a, b], [override('o1', bookId, 'MERGE', 'a', 'b')], {
      timeZone: TZ_SHANGHAI,
      gapMinutes: 90
    });
    expect(a.createdAt).toEqual(snapshotA);
  });

  it('classifies only shape-changing overrides as decisive under current parameters', () => {
    const traces = [
      trace('a', bookId, '2026-09-20T01:00:00.000Z'),
      trace('b', bookId, '2026-09-20T01:10:00.000Z')
    ];

    // 自然相连：MERGE 冗余，不进 decisiveMergeEdges
    const redundantMerge = groupReadingSessions(traces, [override('o1', bookId, 'MERGE', 'a', 'b')], {
      timeZone: 'UTC',
      gapMinutes: 90
    });
    expect(redundantMerge.sessions).toHaveLength(1);
    expect(redundantMerge.decisiveMergeEdges).toHaveLength(0);
    expect(redundantMerge.sessions[0]!.edgeOverrides).toHaveLength(1);

    // 自然相连：SPLIT 真正决定形状
    const decisiveSplit = groupReadingSessions(traces, [override('o2', bookId, 'SPLIT', 'a', 'b')], {
      timeZone: 'UTC',
      gapMinutes: 90
    });
    expect(decisiveSplit.sessions).toHaveLength(2);
    expect(decisiveSplit.decisiveSplitEdges.map((edge) => edge.overrideId)).toEqual(['o2']);
    expect(decisiveSplit.decisiveMergeEdges).toHaveLength(0);

    // 把间隔调小到 5 分钟后自然断开：SPLIT 变为冗余
    const shifted = groupReadingSessions(traces, [override('o2', bookId, 'SPLIT', 'a', 'b')], {
      timeZone: 'UTC',
      gapMinutes: 5
    });
    expect(shifted.sessions).toHaveLength(2);
    expect(shifted.decisiveSplitEdges).toHaveLength(0);

    // 同一参数下，MERGE 变为决定性
    const shiftedMerge = groupReadingSessions(traces, [override('o3', bookId, 'MERGE', 'a', 'b')], {
      timeZone: 'UTC',
      gapMinutes: 5
    });
    expect(shiftedMerge.sessions).toHaveLength(1);
    expect(shiftedMerge.decisiveMergeEdges.map((edge) => edge.overrideId)).toEqual(['o3']);
  });

  it('reclassifies decisiveness when the time zone changes the natural boundary', () => {
    // 上海 22:00 -> 次日 00:30：上海视角自然断开，UTC 视角自然相连
    const traces = [
      trace('a', bookId, '2026-09-20T14:00:00.000Z'),
      trace('b', bookId, '2026-09-20T16:30:00.000Z')
    ];
    const overrides = [override('o1', bookId, 'MERGE', 'a', 'b')];
    const shanghai = groupReadingSessions(traces, overrides, { timeZone: TZ_SHANGHAI, gapMinutes: 240 });
    const utc = groupReadingSessions(traces, overrides, { timeZone: 'UTC', gapMinutes: 240 });
    expect(shanghai.decisiveMergeEdges.map((edge) => edge.overrideId)).toEqual(['o1']);
    expect(utc.decisiveMergeEdges).toHaveLength(0);
  });
});

describe('groupReadingSessions multiple books', () => {
  it('returns an empty result deterministically for no traces', () => {
    const result = groupReadingSessions([], [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(result.sessions).toEqual([]);
    expect(result.staleOverrideIds).toEqual([]);
    expect(result.decisiveMergeEdges).toEqual([]);
    expect(result.decisiveSplitEdges).toEqual([]);
  });

  it('a lone trace forms one session with no edges', () => {
    const result = groupReadingSessions(
      [trace('a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-20T01:00:00.000Z')],
      [],
      { timeZone: 'UTC', gapMinutes: 90 }
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.traceIds).toEqual(['a']);
    expect(result.sessions[0]!.crossedLocalMidnight).toBe(false);
  });

  it('never merges across different books', () => {
    const traces = [
      trace('a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-20T01:00:00.000Z'),
      trace('b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-09-20T01:05:00.000Z')
    ];
    const result = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(result.sessions).toHaveLength(2);
  });

  it('breaks ties by trace id for identical timestamps', () => {
    const traces = [
      trace('z', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-20T01:00:00.000Z'),
      trace('a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-20T01:00:00.000Z')
    ];
    const result = groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 90 });
    expect(result.sessions[0]!.traceIds).toEqual(['a', 'z']);
  });
});

describe('parameter validation and helpers', () => {
  it('rejects invalid gap values and time zones', () => {
    const traces = [trace('a', 'book', '2026-09-20T01:00:00.000Z')];
    expect(() => groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 0 })).toThrow(RangeError);
    expect(() => groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 1441 })).toThrow(RangeError);
    expect(() => groupReadingSessions(traces, [], { timeZone: 'UTC', gapMinutes: 1.5 })).toThrow(RangeError);
    expect(() => groupReadingSessions(traces, [], { timeZone: 'Not/Zone', gapMinutes: 90 })).toThrow(RangeError);
  });

  it('sortTraces and locateEdge behave on ordered sequences', () => {
    const ordered = sortTraces([
      trace('c', 'book', '2026-09-20T03:00:00.000Z'),
      trace('a', 'book', '2026-09-20T01:00:00.000Z'),
      trace('b', 'book', '2026-09-20T02:00:00.000Z')
    ]).map((trace) => trace.id);
    expect(ordered).toEqual(['a', 'b', 'c']);
    expect(locateEdge(ordered.map((id) => ({ id })), 'a', 'b')?.adjacent).toBe(true);
    expect(locateEdge(ordered.map((id) => ({ id })), 'a', 'c')?.adjacent).toBe(false);
    expect(locateEdge(ordered.map((id) => ({ id })), 'a', 'x')).toBeNull();
  });
});
