import { SESSION_DEFAULT_GAP_MINUTES, SESSION_DEFAULT_TIMEZONE } from '@paper-book-traces/shared';
import { AppError } from './errors.js';

/**
 * 阅读会话分组（纯函数、可复算）。
 *
 * 会话不是存储实体，而是从痕迹的 createdAt 时间戳即时派生的视图：
 *   - 同一本书；
 *   - 在指定 IANA 时区内属于同一个本地日历日（跨午夜默认断开，可通过 MERGE 调整连回）；
 *   - 相邻痕迹间隔不超过 gapMinutes。
 *
 * 手工合并 / 拆分只通过 ReadingSessionOverride 生效，本模块不写入也不修改任何数据，
 * 因此会话怎么合、怎么拆都不会移动痕迹时间戳与 ActivityEvent 审计证据。
 * 时区或间隔参数变化后，用新参数重新调用本函数即可完整复算。
 */

export type SessionTraceType = 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK';

export interface SessionTrace {
  id: string;
  bookId: string;
  type: SessionTraceType;
  createdAt: Date;
}

export type SessionOverrideKind = 'MERGE' | 'SPLIT';

export interface SessionOverride {
  id: string;
  bookId: string;
  kind: SessionOverrideKind;
  leftTraceId: string;
  rightTraceId: string;
  /** 生效时间，用于同一边界上同时存在合并与拆分时判定“最后一次调整”。 */
  createdAt: Date;
  revokedAt: Date | null;
}

export interface GroupingParams {
  timezone: string;
  gapMinutes: number;
}

export interface ReadingSession<TTrace extends SessionTrace = SessionTrace> {
  /** 由成员痕迹推导的稳定标识：成员不变则标识不变；纯派生，非数据库主键。 */
  id: string;
  bookId: string;
  /** 会话首条痕迹在请求时区下的本地日期（YYYY-MM-DD）。 */
  date: string;
  /** 会话覆盖到的全部本地日期；多于一个表示该会话跨过了午夜。 */
  localDates: string[];
  spansMidnight: boolean;
  /** 始终取自成员痕迹真实时间戳，任何合并/拆分都不会改动它们。 */
  startedAt: Date;
  endedAt: Date;
  traceIds: string[];
  traceCount: number;
  traces: TTrace[];
  /** 本次复算中实际作用于该会话的调整。 */
  appliedOverrides: Array<{ id: string; kind: SessionOverrideKind }>;
}

export const MIN_GAP_MINUTES = 1;
export const MAX_GAP_MINUTES = 24 * 60;

export function normalizeTimezone(value: string | undefined): string {
  const timezone = (value ?? SESSION_DEFAULT_TIMEZONE).trim();
  if (!isSupportedTimezone(timezone)) {
    throw new AppError(422, 'VALIDATION_ERROR', '时区无效，请使用 IANA 时区名称（如 Asia/Shanghai）', {
      timezone: '时区无效'
    });
  }
  return timezone;
}

export function normalizeGapMinutes(value: number | undefined): number {
  const gap = value ?? SESSION_DEFAULT_GAP_MINUTES;
  if (!Number.isInteger(gap) || gap < MIN_GAP_MINUTES || gap > MAX_GAP_MINUTES) {
    throw new AppError(422, 'VALIDATION_ERROR', `间隔必须是 ${MIN_GAP_MINUTES} 至 ${MAX_GAP_MINUTES} 分钟之间的整数`, {
      gapMinutes: '间隔无效'
    });
  }
  return gap;
}

export function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const localDateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function localDateFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = localDateFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    localDateFormatterCache.set(timezone, formatter);
  }
  return formatter;
}

/** 返回痕迹在指定 IANA 时区下的本地日历日（YYYY-MM-DD）。 */
export function localDateOf(instant: Date, timezone: string): string {
  return localDateFormatter(timezone).format(instant);
}

/** FNV-1a 32 位哈希，输出 8 位十六进制；成员相同时结果稳定，成员变化时结果变化。 */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface BoundaryDecision {
  join: boolean;
  override?: { id: string; kind: SessionOverrideKind };
}

function decideBoundary(
  left: SessionTrace,
  right: SessionTrace,
  params: GroupingParams,
  boundaryOverrides: SessionOverride[]
): BoundaryDecision {
  const sameLocalDay =
    localDateOf(left.createdAt, params.timezone) === localDateOf(right.createdAt, params.timezone);
  const withinGap =
    right.createdAt.getTime() - left.createdAt.getTime() <= params.gapMinutes * 60_000;
  const naturalJoin = sameLocalDay && withinGap;

  // 同一边界上可能先后留下合并与拆分，最后一次未撤销的调整优先。
  const latest = [...boundaryOverrides]
    .filter((override) => override.revokedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return { join: naturalJoin };
  return { join: latest.kind === 'MERGE', override: { id: latest.id, kind: latest.kind } };
}

/**
 * 把痕迹按「同书 + 本地日 + 最大间隔」聚成连续片段。
 *
 * @param traces  当前用户未删除的痕迹（createdAt 为原始时间戳）
 * @param overrides 当前用户相关调整（含已撤销/已失效项也无妨，会自动忽略）
 * @param params  复算参数；换时区或间隔后重新调用即完成复算
 */
export function groupReadingSessions<TTrace extends SessionTrace>(
  traces: readonly TTrace[],
  overrides: readonly SessionOverride[],
  params: GroupingParams
): ReadingSession<TTrace>[] {
  const sorted = [...traces].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.bookId.localeCompare(b.bookId) ||
      a.id.localeCompare(b.id)
  );

  // key: `${bookId}|${leftTraceId}|${rightTraceId}`
  const overrideIndex = new Map<string, SessionOverride[]>();
  for (const override of overrides) {
    if (override.revokedAt !== null) continue;
    const key = `${override.bookId}|${override.leftTraceId}|${override.rightTraceId}`;
    const bucket = overrideIndex.get(key);
    if (bucket) bucket.push(override);
    else overrideIndex.set(key, [override]);
  }

  const sessions: ReadingSession<TTrace>[] = [];
  let current: TTrace[] = [];
  let currentBookId: string | null = null;
  let applied = new Map<string, SessionOverrideKind>();

  const flush = (): void => {
    if (current.length === 0 || currentBookId === null) return;
    const localDates = [...new Set(current.map((trace) => localDateOf(trace.createdAt, params.timezone)))].sort();
    const traceIds = current.map((trace) => trace.id);
    sessions.push({
      id: stableHash(`${currentBookId}|${traceIds.join('|')}`),
      bookId: currentBookId,
      date: localDates[0] as string,
      localDates,
      spansMidnight: localDates.length > 1,
      startedAt: current[0]!.createdAt,
      endedAt: current[current.length - 1]!.createdAt,
      traceIds,
      traceCount: current.length,
      traces: current,
      appliedOverrides: [...applied.entries()].map(([id, kind]) => ({ id, kind }))
    });
  };

  const startNewSession = (trace: TTrace): void => {
    flush();
    current = [trace];
    currentBookId = trace.bookId;
    applied = new Map();
  };

  for (let index = 0; index < sorted.length; index += 1) {
    const trace = sorted[index]!;
    const previous = index > 0 ? sorted[index - 1]! : null;

    if (!previous || previous.bookId !== trace.bookId) {
      startNewSession(trace);
      continue;
    }

    const boundary = overrideIndex.get(`${trace.bookId}|${previous.id}|${trace.id}`) ?? [];
    const decision = decideBoundary(previous, trace, params, boundary);
    if (!decision.join) {
      startNewSession(trace);
    } else {
      current.push(trace);
      if (decision.override) applied.set(decision.override.id, decision.override.kind);
    }
  }
  flush();
  return sessions;
}

/**
 * 判定两条痕迹在当前痕迹序列里是否构成“同书、时间相邻”的边界。
 * 合并 / 拆分只能落在相邻痕迹之间，避免一次调整跨越大段无关痕迹。
 */
export function findConsecutiveBoundary<TTrace extends SessionTrace>(
  traces: readonly TTrace[],
  bookId: string,
  leftTraceId: string,
  rightTraceId: string
): { left: TTrace; right: TTrace } | null {
  const sorted = traces
    .filter((trace) => trace.bookId === bookId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const leftIndex = sorted.findIndex((trace) => trace.id === leftTraceId);
  if (leftIndex < 0) return null;
  const right = sorted[leftIndex + 1];
  if (!right || right.id !== rightTraceId) return null;
  return { left: sorted[leftIndex]!, right };
}

/**
 * 在当前参数下模拟一次边界判定，供接口校验“这次调整是否真的会改变分组”。
 */
export function previewBoundaryDecision<TTrace extends SessionTrace>(
  traces: readonly TTrace[],
  overrides: readonly SessionOverride[],
  params: GroupingParams,
  bookId: string,
  leftTraceId: string,
  rightTraceId: string
): { joined: boolean; applicable: boolean } {
  const boundary = findConsecutiveBoundary(traces, bookId, leftTraceId, rightTraceId);
  if (!boundary) return { joined: false, applicable: false };
  const decision = decideBoundary(
    boundary.left,
    boundary.right,
    params,
    overrides.filter(
      (override) => override.leftTraceId === leftTraceId && override.rightTraceId === rightTraceId
    )
  );
  return { joined: decision.join, applicable: true };
}
