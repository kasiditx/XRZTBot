ALTER TABLE "weekly_collections" ADD COLUMN "manually_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "manually_closed_by_discord_user_id" text;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD COLUMN "manual_closure_reason" text;--> statement-breakpoint
ALTER TABLE "weekly_collections" ADD CONSTRAINT "weekly_collections_manual_close_complete" CHECK ((
      "weekly_collections"."manually_closed_at" IS NULL
      AND "weekly_collections"."manually_closed_by_discord_user_id" IS NULL
      AND "weekly_collections"."manual_closure_reason" IS NULL
    ) OR (
      "weekly_collections"."manually_closed_at" IS NOT NULL
      AND "weekly_collections"."manually_closed_by_discord_user_id" IS NOT NULL
      AND length(trim("weekly_collections"."manually_closed_by_discord_user_id")) > 0
      AND "weekly_collections"."manual_closure_reason" IS NOT NULL
      AND length(trim("weekly_collections"."manual_closure_reason")) > 0
      AND "weekly_collections"."is_closed" = true
    ));