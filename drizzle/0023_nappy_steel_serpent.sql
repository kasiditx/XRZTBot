CREATE TYPE "public"."attendance_proof_status" AS ENUM('PENDING', 'REJECTED');--> statement-breakpoint
CREATE TABLE "attendance_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"round_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"attachment_id" text NOT NULL,
	"log_channel_id" text NOT NULL,
	"log_message_id" text NOT NULL,
	"sha256" text NOT NULL,
	"status" "attendance_proof_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_proofs_sha256_format" CHECK (length("attendance_proofs"."sha256") = 64),
	CONSTRAINT "attendance_proofs_status_fields" CHECK ((
      "attendance_proofs"."status" = 'PENDING'
      AND "attendance_proofs"."decided_at" IS NULL
      AND "attendance_proofs"."decided_by_discord_user_id" IS NULL
      AND "attendance_proofs"."rejection_reason" IS NULL
    ) OR (
      "attendance_proofs"."status" = 'REJECTED'
      AND "attendance_proofs"."decided_at" IS NOT NULL
      AND "attendance_proofs"."decided_by_discord_user_id" IS NOT NULL
      AND length(trim("attendance_proofs"."rejection_reason")) BETWEEN 2 AND 500
    ))
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "attendance_log_channel_id" text;--> statement-breakpoint
ALTER TABLE "attendance_proofs" ADD CONSTRAINT "attendance_proofs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_proofs" ADD CONSTRAINT "attendance_proofs_round_id_attendance_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."attendance_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_proofs" ADD CONSTRAINT "attendance_proofs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "attendance_proofs" (
	"guild_id",
	"round_id",
	"member_id",
	"attachment_id",
	"log_channel_id",
	"log_message_id",
	"sha256",
	"submitted_at",
	"created_at",
	"updated_at"
)
SELECT
	"attendance_rounds"."guild_id",
	"attendance_records"."round_id",
	"attendance_records"."member_id",
	"attendance_records"."proof_attachment_id",
	"attendance_records"."proof_channel_id",
	"attendance_records"."proof_message_id",
	"attendance_records"."proof_sha256",
	COALESCE("attendance_records"."checked_in_at", "attendance_records"."updated_at"),
	"attendance_records"."created_at",
	"attendance_records"."updated_at"
FROM "attendance_records"
INNER JOIN "attendance_rounds"
	ON "attendance_rounds"."id" = "attendance_records"."round_id"
WHERE
	"attendance_records"."proof_attachment_id" IS NOT NULL
	AND "attendance_records"."proof_channel_id" IS NOT NULL
	AND "attendance_records"."proof_message_id" IS NOT NULL
	AND "attendance_records"."proof_sha256" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_proofs_log_message_uq" ON "attendance_proofs" USING btree ("log_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_proofs_sha256_uq" ON "attendance_proofs" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_proofs_one_pending_uq" ON "attendance_proofs" USING btree ("round_id","member_id") WHERE "attendance_proofs"."status" = 'PENDING';
