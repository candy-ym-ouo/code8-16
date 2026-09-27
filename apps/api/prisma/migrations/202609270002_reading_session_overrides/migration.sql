-- CreateTable: 阅读片段人工覆盖（只存覆盖决定，不复制、不移动任何痕迹时间戳）
CREATE TABLE "reading_session_overrides" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "kind" "SessionOverrideKind" NOT NULL,
    "previous_trace_id" UUID NOT NULL,
    "next_trace_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "reading_session_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reading_session_overrides_user_id_book_id_created_at_idx"
  ON "reading_session_overrides"("user_id", "book_id", "created_at");

CREATE INDEX "reading_session_overrides_book_id_previous_next_idx"
  ON "reading_session_overrides"("book_id", "previous_trace_id", "next_trace_id");

-- 同一条“相邻痕迹边”（与提交顺序无关）任意时刻至多一个生效覆盖；
-- 撤销后保留审计行，允许再次创建。
CREATE UNIQUE INDEX "reading_session_overrides_edge_active_key"
  ON "reading_session_overrides"(
    "book_id",
    LEAST("previous_trace_id", "next_trace_id"),
    GREATEST("previous_trace_id", "next_trace_id")
  )
  WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "reading_session_overrides" ADD CONSTRAINT "reading_session_overrides_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reading_session_overrides" ADD CONSTRAINT "reading_session_overrides_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
