ALTER TABLE "weekly_collections" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "cancelled_by_discord_user_id" text;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD CONSTRAINT "weekly_collections_cancellation_complete" CHECK ((
      "weekly_collections"."cancelled_at" IS NULL
      AND "weekly_collections"."cancelled_by_discord_user_id" IS NULL
      AND "weekly_collections"."cancellation_reason" IS NULL
    ) OR (
      "weekly_collections"."cancelled_at" IS NOT NULL
      AND "weekly_collections"."cancelled_by_discord_user_id" IS NOT NULL
      AND length(trim("weekly_collections"."cancellation_reason")) > 0
      AND "weekly_collections"."is_closed" = true
    ));