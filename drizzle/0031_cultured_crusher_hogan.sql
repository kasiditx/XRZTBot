CREATE TYPE "public"."weekly_item_obligation_status" AS ENUM('UNPAID', 'EXEMPT', 'PENDING_VERIFICATION', 'FULFILLED');--> statement-breakpoint
CREATE TABLE "weekly_item_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"request_id" text NOT NULL,
	"title" text NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"first_penalty_at" timestamp with time zone NOT NULL,
	"penalty_run_count" integer DEFAULT 0 NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_discord_user_id" text,
	"cancellation_reason" text,
	"created_by_discord_user_id" text NOT NULL,
	"public_channel_id" text,
	"public_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_item_collections_valid_dates" CHECK ("weekly_item_collections"."ends_on" >= "weekly_item_collections"."starts_on"),
	CONSTRAINT "weekly_item_collections_title_not_blank" CHECK (length(trim("weekly_item_collections"."title")) > 0),
	CONSTRAINT "weekly_item_collections_penalty_count_non_negative" CHECK ("weekly_item_collections"."penalty_run_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_item_obligation_items" (
	"obligation_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	CONSTRAINT "weekly_item_obligation_items_obligation_id_item_id_pk" PRIMARY KEY("obligation_id","item_id"),
	CONSTRAINT "weekly_item_obligation_items_quantity_positive" CHECK ("weekly_item_obligation_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_item_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"status" "weekly_item_obligation_status" DEFAULT 'UNPAID' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"exemption_reason" text,
	"fulfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_item_proof_items" (
	"proof_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	CONSTRAINT "weekly_item_proof_items_proof_id_item_id_pk" PRIMARY KEY("proof_id","item_id"),
	CONSTRAINT "weekly_item_proof_items_quantity_positive" CHECK ("weekly_item_proof_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_item_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"request_id" text NOT NULL,
	"obligation_id" uuid NOT NULL,
	"submitted_by_discord_user_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"log_channel_id" text NOT NULL,
	"log_message_id" text NOT NULL,
	"inventory_batch_id" uuid,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_item_requirements" (
	"collection_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"required_quantity" bigint NOT NULL,
	"initial_penalty_quantity" bigint DEFAULT 0 NOT NULL,
	"recurring_penalty_quantity" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "weekly_item_requirements_collection_id_item_id_pk" PRIMARY KEY("collection_id","item_id"),
	CONSTRAINT "weekly_item_requirements_quantities_valid" CHECK ("weekly_item_requirements"."required_quantity" > 0 and "weekly_item_requirements"."initial_penalty_quantity" >= 0 and "weekly_item_requirements"."recurring_penalty_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "weekly_items_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "weekly_items_log_channel_id" text;--> statement-breakpoint
ALTER TABLE "weekly_item_collections" ADD CONSTRAINT "weekly_item_collections_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_obligation_items" ADD CONSTRAINT "weekly_item_obligation_items_obligation_id_weekly_item_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."weekly_item_obligations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_obligation_items" ADD CONSTRAINT "weekly_item_obligation_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_obligations" ADD CONSTRAINT "weekly_item_obligations_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_obligations" ADD CONSTRAINT "weekly_item_obligations_collection_id_weekly_item_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."weekly_item_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_obligations" ADD CONSTRAINT "weekly_item_obligations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_proof_items" ADD CONSTRAINT "weekly_item_proof_items_proof_id_weekly_item_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."weekly_item_proofs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_proof_items" ADD CONSTRAINT "weekly_item_proof_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_proofs" ADD CONSTRAINT "weekly_item_proofs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_proofs" ADD CONSTRAINT "weekly_item_proofs_obligation_id_weekly_item_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."weekly_item_obligations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_proofs" ADD CONSTRAINT "weekly_item_proofs_inventory_batch_id_inventory_batches_id_fk" FOREIGN KEY ("inventory_batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_requirements" ADD CONSTRAINT "weekly_item_requirements_collection_id_weekly_item_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."weekly_item_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_item_requirements" ADD CONSTRAINT "weekly_item_requirements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_item_collections_guild_request_uq" ON "weekly_item_collections" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE INDEX "weekly_item_collections_penalty_idx" ON "weekly_item_collections" USING btree ("guild_id","is_closed","first_penalty_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_item_obligations_collection_member_uq" ON "weekly_item_obligations" USING btree ("collection_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_item_proofs_guild_request_uq" ON "weekly_item_proofs" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_item_proofs_one_pending_uq" ON "weekly_item_proofs" USING btree ("obligation_id") WHERE "weekly_item_proofs"."status" = 'PENDING';