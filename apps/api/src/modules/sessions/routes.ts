import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';
import {
  findConsecutiveBoundary,
  groupReadingSessions,
  normalizeGapMinutes,
  normalizeTimezone,
  previewBoundaryDecision,
  type SessionTrace,
  type SessionTraceType
} from '../../lib/sessions.js';

const TRACE_TYPE_TO_ENTITY = {
  DOG_EAR: 'DOG_EAR',
  ANNOTATION: 'ANNOTATION',
  REREAD_MARK: 'REREAD_MARK'
} as const satisfies Record<SessionTraceType, 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK'>;

const GLOBAL_TRACE_CAP = 5_000;

const paramsSchema = z.object({
  timezone: z.string().max(64).optional(),
  gapMinutes: z.coerce.number().int().optional()
});

const adjustmentSchema = z.object({
  leftTraceId: z.string().uuid(),
  rightTraceId: z.string().uuid(),
  timezone: z.string().max(64).optional(),
  gapMinutes: z.number().int().optional()
});

type DbClient = Prisma.TransactionClient | typeof prisma;

async function loadActiveTraces(
  client: DbClient,
  userId: string,
  bookId: string,
  enforceCap = false
): Promise<SessionTrace[]> {
  const cap = enforceCap ? GLOBAL_TRACE_CAP + 1 : undefined;
  const [dogEars, annotations, rereadMarks] = await Promise.all([
    client.dogEar.findMany({
      where: { userId, deletedAt: null, bookId },
      select: { id: true, bookId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      ...(cap ? { take: cap } : {})
    }),
    client.annotation.findMany({
      where: { userId, deletedAt: null, bookId },
      select: { id: true, bookId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      ...(cap ? { take: cap } : {})
    }),
    client.rereadMark.findMany({
      where: { userId, deletedAt: null, bookId },
      select: { id: true, bookId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      ...(cap ? { take: cap } : {})
    })
  ]);
  return [
    ...dogEars.map((item) => ({ ...item, type: 'DOG_EAR' as const })),
    ...annotations.map((item) => ({ ...item, type: 'ANNOTATION' as const })),
    ...rereadMarks.map((item) => ({ ...item, type: 'REREAD_MARK' as const }))
  ];
}

async function loadOwnedBook(bookId: string, userId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
  if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
  return book;
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // 复算阅读会话：纯派生视图，只读痕迹时间戳，不写任何数据。
  app.get('/reading-sessions', async (request) => {
    const userId = currentUser(request).id;
    const parsed = paramsSchema.safeParse(request.query);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '会话参数无效', zodFields(parsed.error));
    const timezone = normalizeTimezone(parsed.data.timezone);
    const gapMinutes = normalizeGapMinutes(parsed.data.gapMinutes);

    const query = request.query as Record<string, unknown>;
    const bookId = typeof query.bookId === 'string' && query.bookId ? parseId(query.bookId, 'bookId') : undefined;
    if (bookId) await loadOwnedBook(bookId, userId);

    const books = await prisma.book.findMany({
      where: { userId, deletedAt: null, ...(bookId ? { id: bookId } : {}) },
      select: { id: true, title: true },
      take: GLOBAL_TRACE_CAP + 1
    });
    if (books.length > GLOBAL_TRACE_CAP) {
      throw new AppError(413, 'READING_SESSIONS_TOO_LARGE', '书目过多，请按书目查看阅读会话');
    }

    const tracesByBook = await Promise.all(
      books.map((book) => loadActiveTraces(prisma, userId, book.id, !bookId))
    );
    const traces = tracesByBook.flat();
    if (!bookId && traces.length > GLOBAL_TRACE_CAP) {
      throw new AppError(413, 'READING_SESSIONS_TOO_LARGE', '痕迹过多，请按书目查看阅读会话');
    }

    const overrides = await prisma.readingSessionOverride.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(bookId ? { bookId } : { bookId: { in: books.map((book) => book.id) } })
      },
      orderBy: { createdAt: 'asc' }
    });

    const sessions = groupReadingSessions(traces, overrides, { timezone, gapMinutes })
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((session) => ({
        id: session.id,
        bookId: session.bookId,
        date: session.date,
        localDates: session.localDates,
        spansMidnight: session.spansMidnight,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        traceCount: session.traceCount,
        traceIds: session.traceIds,
        traces: session.traces.map((trace) => ({ id: trace.id, type: trace.type, createdAt: trace.createdAt })),
        appliedOverrides: session.appliedOverrides
      }));

    return {
      params: { timezone, gapMinutes },
      items: sessions,
      overrides: overrides.map((override) => ({
        id: override.id,
        bookId: override.bookId,
        kind: override.kind,
        leftTraceId: override.leftTraceId,
        rightTraceId: override.rightTraceId,
        timezone: override.timezone,
        gapMinutes: override.gapMinutes,
        createdAt: override.createdAt
      }))
    };
  });

  async function applyAdjustment(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    bookId: string,
    kind: 'MERGE' | 'SPLIT'
  ): Promise<unknown> {
    const parsed = adjustmentSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '调整参数无效', zodFields(parsed.error));
    const timezone = normalizeTimezone(parsed.data.timezone);
    const gapMinutes = normalizeGapMinutes(parsed.data.gapMinutes);
    const { leftTraceId, rightTraceId } = parsed.data;
    await loadOwnedBook(bookId, userId);

    const created = await prisma.$transaction(async (tx) => {
      // 锁定书目行，与状态变更使用同样的串行化方式。
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
      const traces = await loadActiveTraces(tx, userId, bookId);
      const boundary = findConsecutiveBoundary(traces, bookId, leftTraceId, rightTraceId);
      if (!boundary) {
        throw new AppError(422, 'SESSION_BOUNDARY_INVALID', '只能在同书时间相邻的两条痕迹之间调整');
      }

      const activeOverrides = await tx.readingSessionOverride.findMany({
        where: { bookId, revokedAt: null }
      });
      const preview = previewBoundaryDecision(
        traces,
        activeOverrides,
        { timezone, gapMinutes },
        bookId,
        leftTraceId,
        rightTraceId
      );
      if (kind === 'MERGE' && preview.joined) {
        throw new AppError(409, 'SESSIONS_ALREADY_JOINED', '这两条痕迹当前已在同一段会话中');
      }
      if (kind === 'SPLIT' && !preview.joined) {
        throw new AppError(409, 'SESSIONS_ALREADY_SPLIT', '这两条痕迹当前已不在同一段会话中');
      }

      // 同一边界、同一意图已有生效调整时拒绝，避免重复审计记录。
      const duplicate = activeOverrides.find(
        (override) =>
          override.kind === kind &&
          override.leftTraceId === leftTraceId &&
          override.rightTraceId === rightTraceId
      );
      if (duplicate) {
        throw new AppError(409, 'SESSION_OVERRIDE_EXISTS', '该调整已经存在，可先撤销后重新调整');
      }

      const record = await tx.readingSessionOverride.create({
        data: {
          userId,
          bookId,
          kind,
          leftTraceId,
          rightTraceId,
          leftTraceType: TRACE_TYPE_TO_ENTITY[boundary.left.type],
          rightTraceType: TRACE_TYPE_TO_ENTITY[boundary.right.type],
          timezone,
          gapMinutes
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'READING_SESSION',
        entityId: record.id,
        action: kind === 'MERGE' ? 'MERGED' : 'SPLIT',
        payload: {
          leftTraceId,
          rightTraceId,
          leftTraceType: TRACE_TYPE_TO_ENTITY[boundary.left.type],
          rightTraceType: TRACE_TYPE_TO_ENTITY[boundary.right.type],
          timezone,
          gapMinutes
        }
      });
      return record;
    });

    return reply.status(201).send({ override: created });
  }

  // 手工合并：仅留下调整记录与审计事件，不改动任何痕迹时间戳。
  app.post('/books/:bookId/reading-sessions/merge', async (request, reply) => {
    const userId = currentUser(request).id;
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    return applyAdjustment(request, reply, userId, bookId, 'MERGE');
  });

  // 手工拆分：同上，只追加调整记录。
  app.post('/books/:bookId/reading-sessions/split', async (request, reply) => {
    const userId = currentUser(request).id;
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    return applyAdjustment(request, reply, userId, bookId, 'SPLIT');
  });

  // 撤销调整：软撤销（revokedAt），审计事件保留；再次复算即回到自动分组。
  app.delete('/reading-session-overrides/:overrideId', async (request, reply) => {
    const userId = currentUser(request).id;
    const overrideId = parseId(
      (request.params as { overrideId: string }).overrideId,
      'overrideId'
    );
    await prisma.$transaction(async (tx) => {
      const existing = await tx.readingSessionOverride.findFirst({
        where: { id: overrideId, userId }
      });
      if (!existing) throw new AppError(404, 'NOT_FOUND', '调整记录不存在');
      if (existing.revokedAt) throw new AppError(409, 'SESSION_OVERRIDE_REVOKED', '该调整已撤销');
      await tx.readingSessionOverride.update({
        where: { id: overrideId },
        data: { revokedAt: new Date() }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'READING_SESSION',
        entityId: existing.id,
        action: 'DELETED',
        payload: { kind: existing.kind, reason: 'revoked' }
      });
    });
    return reply.status(204).send();
  });
};
