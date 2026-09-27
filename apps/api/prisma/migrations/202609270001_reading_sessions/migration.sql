-- AlterEnum
ALTER TYPE "ActivityEntityType" ADD VALUE 'READING_SESSION';

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'MERGED';

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'SPLIT';

-- CreateEnum
CREATE TYPE "SessionOverrideKind" AS ENUM ('MERGE', 'SPLIT');

-- CreateTable
CREATE TABLE "reading_session_overrides" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "kind" "SessionOverrideKind" NOT NULL,
    "left_trace_id" UUID NOT NULL,
    "right_trace_id" UUID NOT NULL,
    "left_trace_type" "ActivityEntityType" NOT NULL,
    "right_trace_type" "ActivityEntityType" NOT NULL,
    "timezone" TEXT NOT NULL,
    "gap_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "reading_session_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reading_session_overrides_user_id_book_id_revoked_at_idx"
  ON "reading_session_overrides"("user_id", "book_id", "revoked_at");

-- CreateIndex
CREATE INDEX "reading_session_overrides_left_trace_id_idx"
  ON "reading_session_overrides"("left_trace_id");

-- CreateIndex
CREATE INDEX "reading_session_overrides_right_trace_id_idx"
  ON "reading_session_overrides"("right_trace_id");

-- 同一边界上同一种调整只允许有一条生效记录（撤销后可重新调整）。
CREATE UNIQUE INDEX "reading_session_overrides_boundary_active_key"
  ON "reading_session_overrides"("book_id", "kind", "left_trace_id", "right_trace_id")
  WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "reading_session_overrides" ADD CONSTRAINT "reading_session_overrides_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reading_session_overrides" ADD CONSTRAINT "reading_session_overrides_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
