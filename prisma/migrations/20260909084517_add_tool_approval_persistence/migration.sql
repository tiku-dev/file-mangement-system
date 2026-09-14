-- CreateTable
CREATE TABLE "ai_tool_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "ai_tool_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_tool_approvals_user_id_status_created_at_idx" ON "ai_tool_approvals"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_conversation_id_created_at_idx" ON "ai_tool_approvals"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_message_id_idx" ON "ai_tool_approvals"("message_id");

-- AddForeignKey
ALTER TABLE "ai_tool_approvals" ADD CONSTRAINT "ai_tool_approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_approvals" ADD CONSTRAINT "ai_tool_approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_approvals" ADD CONSTRAINT "ai_tool_approvals_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- ai_tool_approvals — SCHEMA.md §6.8
-- ----------------------------------------------------------------------------
-- Closed approval-state domain. Transitions are application-enforced
-- (pending → approved | rejected | expired; §6.8).
ALTER TABLE "ai_tool_approvals" ADD CONSTRAINT "ai_tool_approvals_status_check"
  CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired'));
-- Pending-approval queue by owner ordered by expiry (§6.8): serves both the
-- per-user pending list and the expiry sweep (status = 'pending' AND
-- expires_at <= now()).
CREATE INDEX "ai_tool_approvals_user_id_pending_idx"
  ON "ai_tool_approvals" ("user_id", "expires_at") WHERE "status" = 'pending';
