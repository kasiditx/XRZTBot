ALTER TABLE "weekly_obligations" ADD COLUMN "fine_conversion_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD COLUMN "overdue_fine_amount_override" bigint;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD COLUMN "recurring_fine_amount_override" bigint;--> statement-breakpoint
ALTER TABLE "weekly_obligations" ADD CONSTRAINT "weekly_obligations_fine_overrides_non_negative" CHECK ((
      "weekly_obligations"."overdue_fine_amount_override" IS NULL OR "weekly_obligations"."overdue_fine_amount_override" >= 0
    ) AND (
      "weekly_obligations"."recurring_fine_amount_override" IS NULL OR "weekly_obligations"."recurring_fine_amount_override" >= 0
    ));