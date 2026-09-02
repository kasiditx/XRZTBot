CREATE TYPE "public"."activity_status" AS ENUM('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."attendance_result" AS ENUM('PRESENT', 'LEAVE', 'EMERGENCY_LEAVE', 'ABSENT');--> statement-breakpoint
CREATE TYPE "public"."attendance_round_status" AS ENUM('SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."fine_status" AS ENUM('UNPAID', 'PENDING_VERIFICATION', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inventory_action" AS ENUM('OPENING', 'ADD', 'REMOVE', 'WITHDRAWAL', 'DEPOSIT', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('PENDING', 'ACTIVE', 'REJECTED', 'FORMER');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."scheduled_job_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."treasury_entry_type" AS ENUM('OPENING_BALANCE', 'INCOME', 'EXPENSE', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."weekly_obligation_status" AS ENUM('UNPAID', 'EXEMPT', 'PENDING_VERIFICATION', 'PAID', 'CONVERTED_TO_FINE');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"title" text NOT NULL,
	"details" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "activity_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by_discord_user_id" text NOT NULL,
	"announcement_message_id" text,
	"leaderboard_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_valid_window" CHECK ("activities"."ends_at" > "activities"."starts_at"),
	CONSTRAINT "activities_title_not_blank" CHECK (length(trim("activities"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "activity_score_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"points" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_score_items_points_non_negative" CHECK ("activity_score_items"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "activity_submission_participants" (
	"submission_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "activity_submission_participants_submission_id_member_id_pk" PRIMARY KEY("submission_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "activity_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"activity_id" uuid NOT NULL,
	"score_item_id" uuid NOT NULL,
	"submitter_member_id" uuid NOT NULL,
	"note" text,
	"image_attachment_ids" jsonb NOT NULL,
	"log_message_id" text,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_discord_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_submissions_images_count" CHECK (jsonb_array_length("activity_submissions"."image_attachment_ids") between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"round_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"result" "attendance_result" NOT NULL,
	"checked_in_at" timestamp with time zone,
	"leave_id" uuid,
	"corrected_by_discord_user_id" text,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_records_round_id_member_id_pk" PRIMARY KEY("round_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"title" text NOT NULL,
	"attendance_date" text NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"status" "attendance_round_status" DEFAULT 'SCHEDULED' NOT NULL,
	"source_schedule_id" uuid,
	"announcement_message_id" text,
	"created_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_rounds_valid_window" CHECK ("attendance_rounds"."closes_at" > "attendance_rounds"."opens_at"),
	CONSTRAINT "attendance_rounds_date_format" CHECK ("attendance_rounds"."attendance_date" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
CREATE TABLE "attendance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"weekdays" jsonb NOT NULL,
	"opens_at_local_time" text NOT NULL,
	"closes_at_local_time" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_schedules_weekdays_not_empty" CHECK (jsonb_array_length("attendance_schedules"."weekdays") > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"actor_discord_user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposit_request_items" (
	"request_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	CONSTRAINT "deposit_request_items_request_id_item_id_pk" PRIMARY KEY("request_id","item_id"),
	CONSTRAINT "deposit_request_items_quantity_positive" CHECK ("deposit_request_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "deposit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"sender_member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"attachment_id" text NOT NULL,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"inventory_batch_id" uuid,
	"public_message_id" text,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fight_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fight_positions_name_not_blank" CHECK (length(trim("fight_positions"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "fine_payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"fine_id" uuid NOT NULL,
	"submitted_by_discord_user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"attachment_id" text NOT NULL,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fine_payment_proofs_amount_positive" CHECK ("fine_payment_proofs"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "fines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"member_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"principal_amount" bigint NOT NULL,
	"surcharge_amount" bigint DEFAULT 0 NOT NULL,
	"accrued_surcharge_amount" bigint DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"next_surcharge_at" timestamp with time zone NOT NULL,
	"status" "fine_status" DEFAULT 'UNPAID' NOT NULL,
	"source_type" text DEFAULT 'MANUAL' NOT NULL,
	"source_id" text,
	"created_by_discord_user_id" text NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fines_principal_positive" CHECK ("fines"."principal_amount" > 0),
	CONSTRAINT "fines_surcharge_non_negative" CHECK ("fines"."surcharge_amount" >= 0),
	CONSTRAINT "fines_accrued_non_negative" CHECK ("fines"."accrued_surcharge_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"dev_role_id" text,
	"head_role_id" text,
	"deputy_role_id" text,
	"active_member_role_id" text,
	"former_member_role_id" text,
	"control_channel_id" text,
	"member_channel_id" text,
	"activity_channel_id" text,
	"activity_log_channel_id" text,
	"attendance_channel_id" text,
	"leave_channel_id" text,
	"fine_channel_id" text,
	"treasury_channel_id" text,
	"weekly_dues_channel_id" text,
	"stock_channel_id" text,
	"fight_position_channel_id" text,
	"audit_channel_id" text,
	"control_panel_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"batch_ref" text NOT NULL,
	"file_hash" text,
	"source_type" text NOT NULL,
	"source_id" text,
	"original_attachment_id" text,
	"reason" text NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_discord_user_id" text,
	"created_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"item_code" text NOT NULL,
	"item_name" text NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_quantity_non_negative" CHECK ("inventory_items"."quantity" >= 0),
	CONSTRAINT "inventory_items_name_not_blank" CHECK (length(trim("inventory_items"."item_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"action" "inventory_action" NOT NULL,
	"quantity_change" bigint NOT NULL,
	"quantity_before" bigint NOT NULL,
	"quantity_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_change_non_zero" CHECK ("inventory_movements"."quantity_change" <> 0),
	CONSTRAINT "inventory_movements_quantities_non_negative" CHECK ("inventory_movements"."quantity_before" >= 0 and "inventory_movements"."quantity_after" >= 0),
	CONSTRAINT "inventory_movements_math" CHECK ("inventory_movements"."quantity_after" = "inventory_movements"."quantity_before" + "inventory_movements"."quantity_change")
);
--> statement-breakpoint
CREATE TABLE "leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"member_id" uuid NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"reason" text NOT NULL,
	"status" "leave_status" DEFAULT 'ACTIVE' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"public_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaves_valid_dates" CHECK ("leaves"."ends_on" >= "leaves"."starts_on"),
	CONSTRAINT "leaves_reason_not_blank" CHECK (length(trim("leaves"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "member_fight_positions" (
	"guild_id" text NOT NULL,
	"member_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"assigned_by_discord_user_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_fight_positions_guild_id_member_id_pk" PRIMARY KEY("guild_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"in_game_name" text NOT NULL,
	"status" "member_status" DEFAULT 'PENDING' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"departure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_in_game_name_not_blank" CHECK (length(trim("members"."in_game_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"job_type" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "scheduled_job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_jobs_attempts_non_negative" CHECK ("scheduled_jobs"."attempts" >= 0),
	CONSTRAINT "scheduled_jobs_max_attempts_positive" CHECK ("scheduled_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "treasury_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"entry_type" "treasury_entry_type" NOT NULL,
	"amount" bigint NOT NULL,
	"description" text NOT NULL,
	"attachment_id" text,
	"source_type" text,
	"source_id" text,
	"reversal_of_entry_id" uuid,
	"created_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_entries_amount_non_zero" CHECK ("treasury_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"title" text NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"standard_amount" bigint NOT NULL,
	"overdue_fine_amount" bigint DEFAULT 0 NOT NULL,
	"recurring_fine_amount" bigint DEFAULT 0 NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"created_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_collections_valid_dates" CHECK ("weekly_collections"."ends_on" >= "weekly_collections"."starts_on"),
	CONSTRAINT "weekly_collections_amount_non_negative" CHECK ("weekly_collections"."standard_amount" >= 0 and "weekly_collections"."overdue_fine_amount" >= 0 and "weekly_collections"."recurring_fine_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "weekly_obligation_status" DEFAULT 'UNPAID' NOT NULL,
	"attachment_id" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"converted_fine_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_obligations_amount_non_negative" CHECK ("weekly_obligations"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "withdrawal_fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"inventory_batch_id" uuid NOT NULL,
	"partial_reason" text,
	"fulfilled_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawal_request_items" (
	"request_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"requested_quantity" bigint NOT NULL,
	"fulfilled_quantity" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "withdrawal_request_items_request_id_item_id_pk" PRIMARY KEY("request_id","item_id"),
	CONSTRAINT "withdrawal_request_items_requested_positive" CHECK ("withdrawal_request_items"."requested_quantity" > 0),
	CONSTRAINT "withdrawal_request_items_fulfilled_valid" CHECK ("withdrawal_request_items"."fulfilled_quantity" >= 0 and "withdrawal_request_items"."fulfilled_quantity" <= "withdrawal_request_items"."requested_quantity")
);
--> statement-breakpoint
CREATE TABLE "withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"requester_member_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "withdrawal_status" DEFAULT 'PENDING' NOT NULL,
	"public_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_score_items" ADD CONSTRAINT "activity_score_items_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submission_participants" ADD CONSTRAINT "activity_submission_participants_submission_id_activity_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."activity_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submission_participants" ADD CONSTRAINT "activity_submission_participants_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD CONSTRAINT "activity_submissions_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD CONSTRAINT "activity_submissions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD CONSTRAINT "activity_submissions_score_item_id_activity_score_items_id_fk" FOREIGN KEY ("score_item_id") REFERENCES "public"."activity_score_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD CONSTRAINT "activity_submissions_submitter_member_id_members_id_fk" FOREIGN KEY ("submitter_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_round_id_attendance_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."attendance_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_leave_id_leaves_id_fk" FOREIGN KEY ("leave_id") REFERENCES "public"."leaves"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_rounds" ADD CONSTRAINT "attendance_rounds_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_request_items" ADD CONSTRAINT "deposit_request_items_request_id_deposit_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."deposit_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_request_items" ADD CONSTRAINT "deposit_request_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_sender_member_id_members_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_inventory_batch_id_inventory_batches_id_fk" FOREIGN KEY ("inventory_batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fight_positions" ADD CONSTRAINT "fight_positions_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ADD CONSTRAINT "fine_payment_proofs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ADD CONSTRAINT "fine_payment_proofs_fine_id_fines_id_fk" FOREIGN KEY ("fine_id") REFERENCES "public"."fines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fight_positions" ADD CONSTRAINT "member_fight_positions_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fight_positions" ADD CONSTRAINT "member_fight_positions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fight_positions" ADD CONSTRAINT "member_fight_positions_position_id_fight_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."fight_positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_entries" ADD CONSTRAINT "treasury_entries_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD CONSTRAINT "weekly_collections_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD CONSTRAINT "weekly_obligations_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD CONSTRAINT "weekly_obligations_collection_id_weekly_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."weekly_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD CONSTRAINT "weekly_obligations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD CONSTRAINT "weekly_obligations_converted_fine_id_fines_id_fk" FOREIGN KEY ("converted_fine_id") REFERENCES "public"."fines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_fulfillments" ADD CONSTRAINT "withdrawal_fulfillments_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_fulfillments" ADD CONSTRAINT "withdrawal_fulfillments_request_id_withdrawal_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."withdrawal_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_fulfillments" ADD CONSTRAINT "withdrawal_fulfillments_inventory_batch_id_inventory_batches_id_fk" FOREIGN KEY ("inventory_batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_request_items" ADD CONSTRAINT "withdrawal_request_items_request_id_withdrawal_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."withdrawal_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_request_items" ADD CONSTRAINT "withdrawal_request_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_requester_member_id_members_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_guild_status_idx" ON "activities" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_score_items_activity_name_uq" ON "activity_score_items" USING btree ("activity_id","name");--> statement-breakpoint
CREATE INDEX "activity_submissions_activity_idx" ON "activity_submissions" USING btree ("guild_id","activity_id");--> statement-breakpoint
CREATE INDEX "attendance_rounds_guild_date_idx" ON "attendance_rounds" USING btree ("guild_id","attendance_date");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("guild_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "deposit_requests_status_idx" ON "deposit_requests" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fight_positions_guild_name_uq" ON "fight_positions" USING btree ("guild_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fine_payment_proofs_one_pending_uq" ON "fine_payment_proofs" USING btree ("fine_id") WHERE "fine_payment_proofs"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "fines_due_idx" ON "fines" USING btree ("guild_id","status","next_surcharge_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_batches_guild_ref_uq" ON "inventory_batches" USING btree ("guild_id","batch_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_batches_guild_hash_uq" ON "inventory_batches" USING btree ("guild_id","file_hash") WHERE "inventory_batches"."file_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_guild_code_uq" ON "inventory_items" USING btree ("guild_id","item_code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_guild_name_uq" ON "inventory_items" USING btree ("guild_id","item_name");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" USING btree ("guild_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "leaves_member_dates_idx" ON "leaves" USING btree ("guild_id","member_id","starts_on","ends_on");--> statement-breakpoint
CREATE INDEX "member_fight_positions_position_idx" ON "member_fight_positions" USING btree ("guild_id","position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_guild_discord_user_uq" ON "members" USING btree ("guild_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "members_guild_status_idx" ON "members" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_jobs_deduplication_uq" ON "scheduled_jobs" USING btree ("guild_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "treasury_entries_guild_created_idx" ON "treasury_entries" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_entries_source_uq" ON "treasury_entries" USING btree ("guild_id","source_type","source_id") WHERE "treasury_entries"."source_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_entries_reversal_uq" ON "treasury_entries" USING btree ("reversal_of_entry_id") WHERE "treasury_entries"."reversal_of_entry_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_obligations_collection_member_uq" ON "weekly_obligations" USING btree ("collection_id","member_id");--> statement-breakpoint
CREATE INDEX "withdrawal_fulfillments_request_idx" ON "withdrawal_fulfillments" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests" USING btree ("guild_id","status");