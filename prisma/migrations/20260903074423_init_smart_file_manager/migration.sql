-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "device_uid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "app_version" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "parent_folder_id" UUID,
    "name" TEXT NOT NULL,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "parent_folder_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT,
    "current_version_id" UUID,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_tags" (
    "file_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_tags_pkey" PRIMARY KEY ("file_id","tag_id")
);

-- CreateTable
CREATE TABLE "folder_tags" (
    "folder_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folder_tags_pkey" PRIMARY KEY ("folder_id","tag_id")
);

-- CreateTable
CREATE TABLE "device_file_state" (
    "device_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "local_path" TEXT,
    "local_mtime" TIMESTAMPTZ,
    "local_version_id" UUID,
    "sync_status" TEXT NOT NULL,
    "conflicting_version_id" UUID,
    "last_error" TEXT,
    "last_synced_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ,

    CONSTRAINT "device_file_state_pkey" PRIMARY KEY ("device_id","file_id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "file_id" UUID,
    "folder_id" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_file_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version_id" UUID,
    "conversation_id" UUID,
    "message_id" UUID,
    "analysis_id" UUID,
    "action_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_file_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "analysis_kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result_data" JSONB,
    "result_summary" TEXT,
    "extracted_text_key" TEXT,
    "model" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_instructions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_instruction_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instruction_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "instruction" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_instruction_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "conversation_id" UUID,
    "message_id" UUID,
    "action_type" TEXT NOT NULL,
    "target_file_id" UUID,
    "target_folder_id" UUID,
    "destination_folder_id" UUID,
    "proposed_params" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,
    "executed_at" TIMESTAMPTZ,

    CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_device_uid_key" ON "devices"("user_id", "device_uid");

-- CreateIndex
CREATE INDEX "folders_user_id_parent_folder_id_idx" ON "folders"("user_id", "parent_folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_current_version_id_key" ON "files"("current_version_id");

-- CreateIndex
CREATE INDEX "files_user_id_parent_folder_id_idx" ON "files"("user_id", "parent_folder_id");

-- CreateIndex
CREATE INDEX "files_user_id_deleted_at_idx" ON "files"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX "file_versions_sha256_idx" ON "file_versions"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_file_id_version_number_key" ON "file_versions"("file_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_storage_key_key" ON "file_versions"("storage_key");

-- CreateIndex
CREATE INDEX "file_tags_tag_id_idx" ON "file_tags"("tag_id");

-- CreateIndex
CREATE INDEX "folder_tags_tag_id_idx" ON "folder_tags"("tag_id");

-- CreateIndex
CREATE INDEX "device_file_state_file_id_idx" ON "device_file_state"("file_id");

-- CreateIndex
CREATE INDEX "activity_events_user_id_occurred_at_idx" ON "activity_events"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_file_id_idx" ON "activity_events"("file_id");

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_updated_at_idx" ON "ai_conversations"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_file_references_file_id_idx" ON "ai_file_references"("file_id");

-- CreateIndex
CREATE INDEX "ai_file_references_version_id_idx" ON "ai_file_references"("version_id");

-- CreateIndex
CREATE INDEX "ai_file_references_conversation_id_created_at_idx" ON "ai_file_references"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_file_references_analysis_id_idx" ON "ai_file_references"("analysis_id");

-- CreateIndex
CREATE INDEX "ai_file_references_action_id_idx" ON "ai_file_references"("action_id");

-- CreateIndex
CREATE INDEX "ai_file_references_message_id_idx" ON "ai_file_references"("message_id");

-- CreateIndex
CREATE INDEX "ai_analyses_file_id_version_id_idx" ON "ai_analyses"("file_id", "version_id");

-- CreateIndex
CREATE INDEX "ai_analyses_user_id_analysis_kind_created_at_idx" ON "ai_analyses"("user_id", "analysis_kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_instruction_versions_instruction_id_version_number_key" ON "ai_instruction_versions"("instruction_id", "version_number");

-- CreateIndex
CREATE INDEX "ai_actions_conversation_id_idx" ON "ai_actions"("conversation_id");

-- CreateIndex
CREATE INDEX "ai_actions_target_file_id_idx" ON "ai_actions"("target_file_id");

-- CreateIndex
CREATE INDEX "ai_actions_target_folder_id_idx" ON "ai_actions"("target_folder_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_parent_folder_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "file_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_tags" ADD CONSTRAINT "file_tags_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_tags" ADD CONSTRAINT "file_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder_tags" ADD CONSTRAINT "folder_tags_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder_tags" ADD CONSTRAINT "folder_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_file_state" ADD CONSTRAINT "device_file_state_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_file_state" ADD CONSTRAINT "device_file_state_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_file_state" ADD CONSTRAINT "device_file_state_local_version_id_fkey" FOREIGN KEY ("local_version_id") REFERENCES "file_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_file_state" ADD CONSTRAINT "device_file_state_conflicting_version_id_fkey" FOREIGN KEY ("conflicting_version_id") REFERENCES "file_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "file_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "ai_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "ai_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "file_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_instructions" ADD CONSTRAINT "ai_instructions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_instruction_versions" ADD CONSTRAINT "ai_instruction_versions_instruction_id_fkey" FOREIGN KEY ("instruction_id") REFERENCES "ai_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_target_file_id_fkey" FOREIGN KEY ("target_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_target_folder_id_fkey" FOREIGN KEY ("target_folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_destination_folder_id_fkey" FOREIGN KEY ("destination_folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- CUSTOM SQL — required by SCHEMA.md (§5, §6) but not expressible in Prisma's
-- schema language (PSL). Appended during initial-migration review, per the
-- "CUSTOM SQL REQUIRED IN MIGRATION" markers in prisma/schema.prisma.
-- SCHEMA.md remains the authoritative specification.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- users — SCHEMA.md §5.1
-- ----------------------------------------------------------------------------
-- Case-insensitive account identity (spec: UNIQUE on lower(email), not email).
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));
-- Closed account-status domain (default 'active' comes from the PSL above).
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'disabled'));

-- ----------------------------------------------------------------------------
-- folders — SCHEMA.md §5.3
-- ----------------------------------------------------------------------------
-- Sibling names unique among non-deleted folders (expression + partial).
CREATE UNIQUE INDEX "folders_parent_folder_id_name_lower_key"
  ON "folders" ("parent_folder_id", lower("name"))
  WHERE "deleted_at" IS NULL;
-- Exactly one root folder per user (partial unique on the NULL parent).
CREATE UNIQUE INDEX "folders_one_root_per_user_key"
  ON "folders" ("user_id")
  WHERE "parent_folder_id" IS NULL;
-- Folder names are non-empty and bounded.
ALTER TABLE "folders" ADD CONSTRAINT "folders_name_check" CHECK (char_length("name") BETWEEN 1 AND 255);
-- Starred view (§8).
CREATE INDEX "folders_user_id_starred_idx" ON "folders" ("user_id") WHERE "is_starred";
-- Trash view (§8): soft-deleted folders.
CREATE INDEX "folders_user_id_deleted_at_trash_idx" ON "folders" ("user_id") WHERE "deleted_at" IS NOT NULL;

-- ----------------------------------------------------------------------------
-- files — SCHEMA.md §5.4
-- ----------------------------------------------------------------------------
-- Sibling names unique among non-deleted files (expression + partial).
CREATE UNIQUE INDEX "files_parent_folder_id_name_lower_key"
  ON "files" ("parent_folder_id", lower("name"))
  WHERE "deleted_at" IS NULL;
-- File names are non-empty and bounded.
ALTER TABLE "files" ADD CONSTRAINT "files_name_check" CHECK (char_length("name") BETWEEN 1 AND 255);
-- Starred view (§8). (Trash lookups use the regular (user_id, deleted_at) index.)
CREATE INDEX "files_user_id_starred_idx" ON "files" ("user_id") WHERE "is_starred";

-- ----------------------------------------------------------------------------
-- file_versions — SCHEMA.md §5.5
-- ----------------------------------------------------------------------------
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_size_bytes_check" CHECK ("size_bytes" >= 0);
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_version_number_check" CHECK ("version_number" >= 1);

-- ----------------------------------------------------------------------------
-- tags — SCHEMA.md §5.6
-- ----------------------------------------------------------------------------
-- Case-insensitive, per-user tag names (expression index; also serves
-- user_id-prefix lookups — no standalone user_id index, per the audit).
CREATE UNIQUE INDEX "tags_user_id_name_lower_key" ON "tags" ("user_id", lower("name"));

-- ----------------------------------------------------------------------------
-- device_file_state — SCHEMA.md §5.8
-- ----------------------------------------------------------------------------
-- Closed sync-status domain.
ALTER TABLE "device_file_state" ADD CONSTRAINT "device_file_state_sync_status_check" CHECK ("sync_status" IN ('synced', 'pending_upload', 'uploading', 'pending_download', 'downloading', 'conflict', 'error'));
-- Per-device work/retry queue (§8).
CREATE INDEX "device_file_state_queue_idx" ON "device_file_state" ("device_id", "sync_status") WHERE "sync_status" <> 'synced';

-- ----------------------------------------------------------------------------
-- activity_events — SCHEMA.md §5.9
-- ----------------------------------------------------------------------------
-- Closed action domain. ("At least one of file_id/folder_id" is app-enforced.)
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_action_check" CHECK ("action" IN ('upload', 'download', 'create', 'rename', 'move', 'delete', 'restore', 'star', 'unstar', 'tag', 'untag'));

-- ----------------------------------------------------------------------------
-- ai_conversations — SCHEMA.md §6.1: no custom SQL required (its only index,
-- (user_id, updated_at DESC), is PSL-native; cascade rules are PSL-native).
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- ai_messages — SCHEMA.md §6.2
-- ----------------------------------------------------------------------------
-- Closed message-role domain (append-only transcript; corrections are new
-- messages, never edits).
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_role_check" CHECK ("role" IN ('user', 'assistant', 'system'));

-- ----------------------------------------------------------------------------
-- ai_file_references — SCHEMA.md §6.3
-- ----------------------------------------------------------------------------
-- Exact-one-context rule (A2): a citation points at precisely ONE of
-- conversation, message, analysis, or action — the most specific context wins
-- (a message implies its conversation, but only message_id is set).
ALTER TABLE "ai_file_references" ADD CONSTRAINT "ai_file_references_context_check"
  CHECK (num_nonnulls("conversation_id", "message_id", "analysis_id", "action_id") = 1);

-- ----------------------------------------------------------------------------
-- ai_analyses — SCHEMA.md §6.4
-- ----------------------------------------------------------------------------
-- Closed analysis-kind and status domains. ai_file_insights was superseded and
-- dropped: any future "insight" is a new analysis_kind here, not a new table.
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_analysis_kind_check"
  CHECK ("analysis_kind" IN ('summary', 'classification', 'tag_suggestion', 'organization_suggestion', 'content_extraction', 'duplicate_hint'));
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_status_check"
  CHECK ("status" IN ('pending', 'completed', 'failed'));
-- Analysis work queue (§6.4).
CREATE INDEX "ai_analyses_user_id_pending_idx"
  ON "ai_analyses" ("user_id") WHERE "status" = 'pending';

-- ----------------------------------------------------------------------------
-- ai_instructions — SCHEMA.md §6.5
-- ----------------------------------------------------------------------------
-- Case-insensitive, per-user instruction names (expression unique index).
CREATE UNIQUE INDEX "ai_instructions_user_id_name_lower_key"
  ON "ai_instructions" ("user_id", lower("name"));

-- ----------------------------------------------------------------------------
-- ai_instruction_versions — SCHEMA.md §6.6
-- ----------------------------------------------------------------------------
-- Closed version-source domain. (Append-only history; (instruction_id,
-- version_number) uniqueness is PSL-native.)
ALTER TABLE "ai_instruction_versions" ADD CONSTRAINT "ai_instruction_versions_source_check"
  CHECK ("source" IN ('user', 'ai_suggestion'));

-- ----------------------------------------------------------------------------
-- ai_actions — SCHEMA.md §6.7
-- ----------------------------------------------------------------------------
-- Closed action-type domain. The ONLY way AI intent reaches the filesystem:
-- rows are inert data until an application service executes them (A1/§12).
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_action_type_check"
  CHECK ("action_type" IN ('rename_file', 'move_file', 'delete_file', 'rename_folder', 'move_folder', 'delete_folder', 'create_folder', 'apply_tags', 'remove_tags', 'star_file', 'unstar_file'));
-- Closed approval-state domain. Transitions are application-enforced
-- (proposed → approved | rejected | cancelled; approved → executing →
-- executed | failed; failed → executing retry in place, §6.7).
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_status_check"
  CHECK ("status" IN ('proposed', 'approved', 'rejected', 'executing', 'executed', 'failed', 'cancelled'));
-- Pending-approval queue (§6.7).
CREATE INDEX "ai_actions_user_id_pending_approval_idx"
  ON "ai_actions" ("user_id") WHERE "status" IN ('proposed', 'approved');
