import { createHash } from 'node:crypto';
import type { SessionOverrideKind, TraceType } from '@paper-book-traces/shared';

/**
 * 阅读片段分组：纯函数派生视图。
 *
 * 规则：
 * - 仅按 (书, 时区下的本地日历日) 分桶，相邻痕迹间隔不超过 gapMinutes 即自然相连；
 * - MERGE 覆盖强制连接相邻痕迹（可跨过午夜、跨更大间隔）；
 * - SPLIT 覆盖强制断开相邻痕迹；
 * - 覆盖是与时区/间隔参数无关的“绝对事实”，参数变化时重新计算即可；
 * - 不读写、不移动任何痕迹的 createdAt，片段时间只是对原时间戳的引用。
 */

export interface SessionTraceInput {
  id: string;
  bookId: string;
  type: TraceType;
  createdAt: Date;
}

export interface SessionOverrideInput {
  id: string;
  bookId: string;
  kind: SessionOverrideKind;
  previousTraceId: string;
  nextTraceId: string;
  createdAt: Date;
}

export interface GroupingParams {
  timeZone: string;
  gapMinutes: number;
}

export interface AppliedEdge {
  overrideId: string;
  kind: SessionOverrideKind;
  previousTraceId: string;
  nextTraceId: string;
}

export interface ReadingSession {
  /** 由 书ID + 有序痕迹ID 派生的稳定标识，同样输入永远得到同样结果 */
  key: string;
  bookId: string;
  /** 片段首条痕迹在请求时区下的本地日期 YYYY-MM-DD */
  localDate: string;
  startedAt: Date;
  endedAt: Date;
  traceCount: number;
  traceIds: string[];
  traceTypes: Record<TraceType, number>;
  /** 片段内是否存在本地日期与首日不同的痕迹（跨午夜） */
  crossedLocalMidnight: boolean;
  edgeOverrides: AppliedEdge[];
}

export interface GroupingResult {
  sessions: ReadingSession[];
  /** 覆盖指向的痕迹对已不是相邻活痕迹（删除或中间插入新痕迹），重算时不生效 */
  staleOverrideIds: string[];
  /** 真正改变了分组形状的 MERGE：没有它这条边本会断开 */
  decisiveMergeEdges: AppliedEdge[];
  /** 真正改变了分组形状的 SPLIT：没有它这条边本会相连 */
  decisiveSplitEdges: AppliedEdge[];
  timeZone: string;
  gapMinutes: number;
}

const DAY_TYPE_RECORD: Record<TraceType, number> = {
  DOG_EAR: 0,
  ANNOTATION: 0,
  REREAD_MARK: 0
};

export function assertValidTimeZone(timeZone: unknown): asserts timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) {
    throw new RangeError('时区无效');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new RangeError('时区无效');
  }
}

export function assertValidGapMinutes(gapMinutes: unknown): asserts gapMinutes is number {
  if (!Number.isInteger(gapMinutes) || (gapMinutes as number) < 1 || (gapMinutes as number) > 24 * 60) {
    throw new RangeError('连续片段最大间隔必须是 1 至 1440 分钟之间的整数');
  }
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    // en-CA 的短日期即 YYYY-MM-DD
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    dateFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 取某一刻在指定 IANA 时区下的本地日历日，结果为 YYYY-MM-DD */
export function localCalendarDay(instant: Date, timeZone: string): string {
  return formatterFor(timeZone).format(instant);
}

export function sortTraces<T extends Pick<SessionTraceInput, 'createdAt' | 'id'>>(traces: T[]): T[] {
  return [...traces].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/**
 * 在按时间排序后的活痕迹序列中定位两条痕迹。
 * adjacent=true：二者当前相邻，覆盖可以作用于这条边；
 * adjacent=false：中间还有其他活痕迹，覆盖对本次重算失效。
 */
export function locateEdge(
  orderedTraces: Array<Pick<SessionTraceInput, 'id'>>,
  traceIdA: string,
  traceIdB: string
): { previousId: string; nextId: string; adjacent: boolean; indexA: number; indexB: number } | null {
  const indexA = orderedTraces.findIndex((trace) => trace.id === traceIdA);
  const indexB = orderedTraces.findIndex((trace) => trace.id === traceIdB);
  if (indexA === -1 || indexB === -1 || indexA === indexB) return null;
  const [lo, hi] = indexA < indexB ? [indexA, indexB] : [indexB, indexA];
  return {
    previousId: orderedTraces[lo]!.id,
    nextId: orderedTraces[hi]!.id,
    adjacent: hi - lo === 1,
    indexA,
    indexB
  };
}

function sessionKey(bookId: string, traceIds: string[]): string {
  return createHash('sha256').update(`${bookId}\n${traceIds.join('\n')}`).digest('hex').slice(0, 20);
}

/**
 * 把同书同日的痕迹聚成连续片段。确定性纯函数：
 * 同样的痕迹、覆盖和参数必然得到同样的片段与 key。
 */
export function groupReadingSessions(
  traces: SessionTraceInput[],
  overrides: SessionOverrideInput[],
  params: GroupingParams
): GroupingResult {
  assertValidTimeZone(params.timeZone);
  assertValidGapMinutes(params.gapMinutes);

  const gapMs = params.gapMinutes * 60_000;
  const localDayOf = (instant: Date) => localCalendarDay(instant, params.timeZone);

  const byBook = new Map<string, SessionTraceInput[]>();
  for (const trace of traces) {
    const list = byBook.get(trace.bookId);
    if (list) list.push(trace);
    else byBook.set(trace.bookId, [trace]);
  }

  const sessions: ReadingSession[] = [];
  const staleOverrideIds: string[] = [];
  const decisiveMergeEdges: AppliedEdge[] = [];
  const decisiveSplitEdges: AppliedEdge[] = [];

  for (const [bookId, bookTracesRaw] of byBook) {
    const bookTraces = sortTraces(bookTracesRaw);
    const bookOverrides = overrides.filter((override) => override.bookId === bookId);

    // 边键 -> 覆盖；一条边最多一个生效覆盖
    const edgeMap = new Map<string, AppliedEdge>();
    for (let index = 0; index < bookTraces.length - 1; index += 1) {
      const previous = bookTraces[index]!;
      const next = bookTraces[index + 1]!;
      const override = bookOverrides.find(
        (item) =>
          (item.previousTraceId === previous.id && item.nextTraceId === next.id) ||
          (item.previousTraceId === next.id && item.nextTraceId === previous.id)
      );
      if (override) {
        edgeMap.set(`${previous.id}|${next.id}`, {
          overrideId: override.id,
          kind: override.kind,
          previousTraceId: previous.id,
          nextTraceId: next.id
        });
      }
    }

    for (const override of bookOverrides) {
      const forward = edgeMap.has(`${override.previousTraceId}|${override.nextTraceId}`);
      const reverse = edgeMap.has(`${override.nextTraceId}|${override.previousTraceId}`);
      if (!forward && !reverse) staleOverrideIds.push(override.id);
    }

    let segment: SessionTraceInput[] = [];
    const segmentEdges: AppliedEdge[] = [];

    const flush = (): void => {
      if (segment.length === 0) return;
      const first = segment[0]!;
      const firstDay = localDayOf(first.createdAt);
      const traceTypes: Record<TraceType, number> = { ...DAY_TYPE_RECORD };
      let crossed = false;
      for (const trace of segment) {
        traceTypes[trace.type] += 1;
        if (!crossed && localDayOf(trace.createdAt) !== firstDay) crossed = true;
      }
      const traceIds = segment.map((trace) => trace.id);
      sessions.push({
        key: sessionKey(bookId, traceIds),
        bookId,
        localDate: firstDay,
        startedAt: first.createdAt,
        endedAt: segment[segment.length - 1]!.createdAt,
        traceCount: segment.length,
        traceIds,
        traceTypes,
        crossedLocalMidnight: crossed,
        edgeOverrides: [...segmentEdges]
      });
      segment = [];
      segmentEdges.length = 0;
    };

    for (let index = 0; index < bookTraces.length; index += 1) {
      const trace = bookTraces[index]!;
      segment.push(trace);
      if (index === bookTraces.length - 1) {
        flush();
        break;
      }
      const next = bookTraces[index + 1]!;
      const edgeKey = `${trace.id}|${next.id}`;
      const edge = edgeMap.get(edgeKey);
      const sameLocalDay = localDayOf(trace.createdAt) === localDayOf(next.createdAt);
      const withinGap = next.createdAt.getTime() - trace.createdAt.getTime() <= gapMs;
      const naturallyConnected = sameLocalDay && withinGap;

      const connected = edge ? edge.kind === 'MERGE' : naturallyConnected;
      if (edge) {
        segmentEdges.push(edge);
        // 只有“与自然分组结论相反”的覆盖才真正决定形状；冗余覆盖保留审计但不影响结果
        if (edge.kind === 'MERGE' && !naturallyConnected) decisiveMergeEdges.push(edge);
        if (edge.kind === 'SPLIT' && naturallyConnected) decisiveSplitEdges.push(edge);
      }
      if (!connected) flush();
    }
  }

  sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || a.key.localeCompare(b.key));
  staleOverrideIds.sort();
  const byEdgeKey = (edge: AppliedEdge) => `${edge.previousTraceId}|${edge.nextTraceId}`;
  decisiveMergeEdges.sort((a, b) => byEdgeKey(a).localeCompare(byEdgeKey(b)));
  decisiveSplitEdges.sort((a, b) => byEdgeKey(a).localeCompare(byEdgeKey(b)));
  return {
    sessions,
    staleOverrideIds,
    decisiveMergeEdges,
    decisiveSplitEdges,
    timeZone: params.timeZone,
    gapMinutes: params.gapMinutes
  };
}
