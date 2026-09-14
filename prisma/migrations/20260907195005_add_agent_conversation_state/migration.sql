-- AlterTable
ALTER TABLE "ai_conversations" ADD COLUMN     "max_tool_rounds" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ai_messages" ADD COLUMN     "is_final" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tool_calls" JSONB,
ADD COLUMN     "tool_results" JSONB;
