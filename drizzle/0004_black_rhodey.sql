ALTER TABLE "guild_settings" ADD COLUMN "treasury_panel_message_id" text;--> statement-breakpoint
ALTER TABLE "treasury_entries" ADD COLUMN "balance_after" bigint;--> statement-breakpoint
WITH "running_balances" AS (
  SELECT "id", sum("amount") OVER (
    PARTITION BY "guild_id"
    ORDER BY "created_at", "id"
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS "balance_after"
  FROM "treasury_entries"
)
UPDATE "treasury_entries"
SET "balance_after" = "running_balances"."balance_after"
FROM "running_balances"
WHERE "treasury_entries"."id" = "running_balances"."id";--> statement-breakpoint
ALTER TABLE "treasury_entries" ALTER COLUMN "balance_after" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "treasury_entries" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
ALTER TABLE "treasury_entries" ADD COLUMN "public_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_entries_one_opening_uq" ON "treasury_entries" USING btree ("guild_id") WHERE "treasury_entries"."entry_type" = 'OPENING_BALANCE';--> statement-breakpoint
ALTER TABLE "treasury_entries" ADD CONSTRAINT "treasury_entries_balance_non_negative" CHECK ("treasury_entries"."balance_after" >= 0);
