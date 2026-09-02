CREATE TABLE "treasury_withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"requester_member_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"treasury_entry_id" uuid,
	"public_channel_id" text,
	"public_message_id" text,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_withdrawal_requests_amount_positive" CHECK ("treasury_withdrawal_requests"."amount" > 0),
	CONSTRAINT "treasury_withdrawal_requests_reason_not_blank" CHECK (length(trim("treasury_withdrawal_requests"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "treasury_withdrawal_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "treasury_withdrawal_panel_message_id" text;--> statement-breakpoint
ALTER TABLE "treasury_withdrawal_requests" ADD CONSTRAINT "treasury_withdrawal_requests_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_withdrawal_requests" ADD CONSTRAINT "treasury_withdrawal_requests_requester_member_id_members_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_withdrawal_requests" ADD CONSTRAINT "treasury_withdrawal_requests_treasury_entry_id_treasury_entries_id_fk" FOREIGN KEY ("treasury_entry_id") REFERENCES "public"."treasury_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_withdrawal_requests_guild_client_request_uq" ON "treasury_withdrawal_requests" USING btree ("guild_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_withdrawal_requests_entry_uq" ON "treasury_withdrawal_requests" USING btree ("treasury_entry_id") WHERE "treasury_withdrawal_requests"."treasury_entry_id" is not null;--> statement-breakpoint
CREATE INDEX "treasury_withdrawal_requests_status_idx" ON "treasury_withdrawal_requests" USING btree ("guild_id","status","created_at");