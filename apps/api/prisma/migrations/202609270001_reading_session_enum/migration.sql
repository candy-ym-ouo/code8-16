-- AlterEnum: 审计事件增加“阅读片段”对象类型
ALTER TYPE "ActivityEntityType" ADD VALUE 'READING_SESSION';

-- CreateEnum: 片段覆盖意图（强制合并 / 强制拆分）
CREATE TYPE "SessionOverrideKind" AS ENUM ('MERGE', 'SPLIT');
