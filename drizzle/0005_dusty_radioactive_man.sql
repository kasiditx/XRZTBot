CREATE TABLE "weekly_payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"request_id" text NOT NULL,
	"obligation_id" uuid NOT NULL,
	"submitted_by_discord_user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"attachment_id" text NOT NULL,
	"log_channel_id" text NOT NULL,
	"log_message_id" text NOT NULL,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_proofs_amount_positive" CHECK ("weekly_payment_proofs"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "conversion_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "public_message_id" text;--> statement-breakpoint
UPDATE "weekly_collections" AS "collection"
SET
	"request_id" = 'legacy:' || "collection"."id"::text,
	"conversion_at" = (("collection"."ends_on"::date + 1)::timestamp AT TIME ZONE "settings"."timezone")
FROM "guild_settings" AS "settings"
WHERE "settings"."guild_id" = "collection"."guild_id";--> statement-breakpoint
ALTER TABLE "weekly_collections" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_collections" ALTER COLUMN "conversion_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_payment_proofs" ADD CONSTRAINT "weekly_payment_proofs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_proofs" ADD CONSTRAINT "weekly_payment_proofs_obligation_id_weekly_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."weekly_obligations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_proofs_guild_request_uq" ON "weekly_payment_proofs" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_proofs_one_pending_uq" ON "weekly_payment_proofs" USING btree ("obligation_id") WHERE "weekly_payment_proofs"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_collections_guild_request_uq" ON "weekly_collections" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE INDEX "weekly_collections_conversion_idx" ON "weekly_collections" USING btree ("guild_id","is_closed","conversion_at");--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD CONSTRAINT "weekly_collections_title_not_blank" CHECK (length(trim("weekly_collections"."title")) > 0);
