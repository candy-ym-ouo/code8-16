import { Prisma } from '@prisma/client';
import type { SessionOverrideKind } from '@paper-book-traces/shared';
import { AppError } from './errors.js';
import { prisma } from './prisma.js';
import {
  groupReadingSessions,
  locateEdge,
  sortTraces,
  type ReadingSession,
  type SessionOverrideInput,
  type SessionTraceInput
} from './sessions.js';

type Tx = Prisma.TransactionClient;

interface LiveTraceRow {
  id: string;
  bookId: string;
  type: SessionTraceInput['type'];
  createdAt: Date;
}

/** 读取一本书当前未删除的痕迹。片段只依据活痕迹复算，删除的痕迹不参与。 */
export async function findLiveTraces(tx: Tx | typeof prisma, userId: string, bookId: string): Promise<LiveTraceRow[]> {
  const [dogEars, annotations, rereadMarks] = await Promise.all([
    tx.dogEar.findMany({
      where: { userId, bookId, deletedAt: null },
      select: { id: true, bookId: true, createdAt: true }
    }),
    tx.annotation.findMany({
      where: { userId, bookId, deletedAt: null },
      select: { id: true, bookId: true, createdAt: true }
    }),
    tx.rereadMark.findMany({
      where: { userId, bookId, deletedAt: null },
      select: { id: true, bookId: true, createdAt: true }
    })
  ]);
  return [
    ...dogEars.map((item) => ({ ...item, type: 'DOG_EAR' as const })),
    ...annotations.map((item) => ({ ...item, type: 'ANNOTATION' as const })),
    ...rereadMarks.map((item) => ({ ...item, type: 'REREAD_MARK' as const }))
  ];
}

export async function findActiveOverrides(
  tx: Tx | typeof prisma,
  userId: string,
  bookId: string
): Promise<SessionOverrideInput[]> {
  const rows = await tx.readingSessionOverride.findMany({
    where: { userId, bookId, revokedAt: null },
    orderBy: { createdAt: 'asc' }
  });
  return rows.map((row) => ({
    id: row.id,
    bookId: row.bookId,
    kind: row.kind as SessionOverrideKind,
    previousTraceId: row.previousTraceId,
    nextTraceId: row.nextTraceId,
    createdAt: row.createdAt
  }));
}

export interface ComputedSessions {
  sessions: ReadingSession[];
  staleOverrideIds: string[];
  decisiveMergeEdges: Array<{
    overrideId: string;
    kind: SessionOverrideKind;
    previousTraceId: string;
    nextTraceId: string;
  }>;
  decisiveSplitEdges: Array<{
    overrideId: string;
    kind: SessionOverrideKind;
    previousTraceId: string;
    nextTraceId: string;
  }>;
}

export async function computeBookSessions(
  tx: Tx | typeof prisma,
  userId: string,
  bookId: string,
  params: { timeZone: string; gapMinutes: number }
): Promise<ComputedSessions> {
  const [traces, overrides] = await Promise.all([
    findLiveTraces(tx, userId, bookId),
    findActiveOverrides(tx, userId, bookId)
  ]);
  const result = groupReadingSessions(traces, overrides, params);
  return {
    sessions: result.sessions,
    staleOverrideIds: result.staleOverrideIds,
    decisiveMergeEdges: result.decisiveMergeEdges,
    decisiveSplitEdges: result.decisiveSplitEdges
  };
}

/**
 * 校验两条痕迹当前是同书内的相邻活痕迹，返回按时间定向后的边。
 * 覆盖只允许作用于相邻边；删除痕迹或中间插入新痕迹后，旧覆盖会在复算时失效。
 */
export async function resolveAdjacentEdge(
  tx: Tx | typeof prisma,
  userId: string,
  bookId: string,
  traceIdA: string,
  traceIdB: string
): Promise<{ previousTraceId: string; nextTraceId: string }> {
  const traces = sortTraces(await findLiveTraces(tx, userId, bookId));
  const located = locateEdge(traces, traceIdA, traceIdB);
  if (!located) {
    throw new AppError(404, 'NOT_FOUND', '要调整的痕迹不存在或已删除');
  }
  if (!located.adjacent) {
    throw new AppError(409, 'SESSION_EDGE_NOT_ADJACENT', '两条痕迹当前不相邻，无法直接合并或拆分');
  }
  return { previousTraceId: located.previousId, nextTraceId: located.nextId };
}
