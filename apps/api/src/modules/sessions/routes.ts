import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_SESSION_GAP_MINUTES,
  DEFAULT_SESSION_TIMEZONE,
  SESSION_OVERRIDE_KINDS,
  type SessionOverrideKind
} from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';
import {
  computeBookSessions,
  resolveAdjacentEdge
} from '../../lib/sessionService.js';
import { assertValidTimeZone, type ReadingSession } from '../../lib/sessions.js';

const overrideCreateSchema = z.object({
  kind: z.enum(SESSION_OVERRIDE_KINDS as [SessionOverrideKind, ...SessionOverrideKind[]]),
  traceIdA: z.string().uuid(),
  traceIdB: z.string().uuid()
});

function parseGroupingQuery(query: Record<string, unknown>): { timeZone: string; gapMinutes: number } {
  const timeZone =
    typeof query.timeZone === 'string' && query.timeZone ? query.timeZone : DEFAULT_SESSION_TIMEZONE;
  try {
    assertValidTimeZone(timeZone);
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', '时区无效，请使用 IANA 时区名称（例如 Asia/Shanghai）', {
      timeZone: '时区无效'
    });
  }
  const rawGap = query.gapMinutes === undefined ? DEFAULT_SESSION_GAP_MINUTES : Number(query.gapMinutes);
  if (!Number.isInteger(rawGap) || rawGap < 1 || rawGap > 24 * 60) {
    throw new AppError(422, 'VALIDATION_ERROR', '连续片段最大间隔必须是 1 至 1440 分钟之间的整数', {
      gapMinutes: '间隔分钟数无效'
    });
  }
  return { timeZone, gapMinutes: rawGap };
}

function serializeSession(session: ReadingSession) {
  return {
    key: session.key,
    bookId: session.bookId,
    localDate: session.localDate,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    traceCount: session.traceCount,
    traceIds: session.traceIds,
    traceTypes: session.traceTypes,
    crossedLocalMidnight: session.crossedLocalMidnight,
    // 片段的形状由这些“边覆盖”决定；它们是审计引用，时间戳仍只存在于痕迹本身
    edgeOverrides: session.edgeOverrides
  };
}

function serializeOverride(row: {
  id: string;
  bookId: string;
  kind: SessionOverrideKind;
  previousTraceId: string;
  nextTraceId: string;
  createdAt: Date;
  revokedAt: Date | null;
}) {
  return {
    id: row.id,
    bookId: row.bookId,
    kind: row.kind,
    previousTraceId: row.previousTraceId,
    nextTraceId: row.nextTraceId,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt
  };
}

async function assertBookAccessible(userId: string, bookId: string): Promise<void> {
  const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
  if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // 派生视图：按 (书, 时区本地日, 最大间隔) 复算阅读片段，不持久化片段本身
  app.get('/books/:bookId/reading-sessions', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const query = request.query as Record<string, unknown>;
    const { timeZone, gapMinutes } = parseGroupingQuery(query);
    await assertBookAccessible(userId, bookId);

    const { sessions, staleOverrideIds, decisiveMergeEdges, decisiveSplitEdges } =
      await computeBookSessions(prisma, userId, bookId, {
        timeZone,
        gapMinutes
      });
    const overrides = await prisma.readingSessionOverride.findMany({
      where: { userId, bookId, revokedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    return {
      items: sessions.map(serializeSession),
      overrides: overrides.map(serializeOverride),
      staleOverrideIds,
      decisiveMergeEdges,
      decisiveSplitEdges,
      grouping: { timeZone, gapMinutes }
    };
  });

  // 人工合并/拆分：只写入“边覆盖”这一决定，绝不更新任何痕迹的 createdAt
  app.post('/books/:bookId/reading-session-overrides', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = overrideCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '片段调整参数无效', zodFields(parsed.error));
    }
    if (parsed.data.traceIdA === parsed.data.traceIdB) {
      throw new AppError(422, 'VALIDATION_ERROR', '必须选择两条不同的痕迹', {
        traceIdB: '不能与另一条痕迹相同'
      });
    }
    const userId = currentUser(request).id;
    await assertBookAccessible(userId, bookId);

    const override = await prisma.$transaction(async (tx) => {
      // 锁定该书的覆盖集合，避免并发对同一条边产生两个生效覆盖
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;

      const edge = await resolveAdjacentEdge(
        tx,
        userId,
        bookId,
        parsed.data.traceIdA,
        parsed.data.traceIdB
      );

      const existing = await tx.readingSessionOverride.findFirst({
        where: {
          userId,
          bookId,
          revokedAt: null,
          OR: [
            { previousTraceId: edge.previousTraceId, nextTraceId: edge.nextTraceId },
            { previousTraceId: edge.nextTraceId, nextTraceId: edge.previousTraceId }
          ]
        }
      });

      if (existing) {
        if (existing.kind === parsed.data.kind) {
          // 幂等：同样的决定重复提交，直接返回现有覆盖
          return existing;
        }
        // 同一条边改主意：先把旧决定作废（保留审计行），再写新决定
        await tx.readingSessionOverride.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() }
        });
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: 'READING_SESSION',
          entityId: existing.id,
          action: 'DELETED',
          payload: {
            kind: existing.kind,
            reason: 'replaced',
            previousTraceId: existing.previousTraceId,
            nextTraceId: existing.nextTraceId
          }
        });
      }

      const created = await tx.readingSessionOverride.create({
        data: {
          userId,
          bookId,
          kind: parsed.data.kind,
          previousTraceId: edge.previousTraceId,
          nextTraceId: edge.nextTraceId
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'READING_SESSION',
        entityId: created.id,
        action: parsed.data.kind === 'MERGE' ? 'CREATED' : 'UPDATED',
        payload: {
          kind: created.kind,
          previousTraceId: created.previousTraceId,
          nextTraceId: created.nextTraceId
        }
      });
      return created;
    });

    return {
      override: serializeOverride(override)
    };
  });

  // 撤销覆盖：软删除覆盖行并写审计；原始痕迹及其时间戳、历史事件都不受影响
  app.delete('/reading-session-overrides/:overrideId', async (request, reply) => {
    const id = parseId((request.params as { overrideId: string }).overrideId, 'overrideId');
    const userId = currentUser(request).id;
    const existing = await prisma.readingSessionOverride.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '片段调整记录不存在');
    if (existing.revokedAt) {
      return reply.status(204).send();
    }

    await prisma.$transaction(async (tx) => {
      const result = await tx.readingSessionOverride.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      if (result.count !== 1) return;
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'READING_SESSION',
        entityId: id,
        action: 'DELETED',
        payload: {
          kind: existing.kind,
          previousTraceId: existing.previousTraceId,
          nextTraceId: existing.nextTraceId,
          reason: 'revoked'
        }
      });
    });
    return reply.status(204).send();
  });
};
