ALTER TABLE "fine_payment_proofs" ADD COLUMN "request_id" text;--> statement-breakpoint
UPDATE "fine_payment_proofs" SET "request_id" = 'legacy:' || "id"::text WHERE "request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ADD COLUMN "log_channel_id" text;--> statement-breakpoint
UPDATE "fine_payment_proofs" SET "log_channel_id" = 'legacy:' || "id"::text WHERE "log_channel_id" IS NULL;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ALTER COLUMN "log_channel_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ADD COLUMN "log_message_id" text;--> statement-breakpoint
UPDATE "fine_payment_proofs" SET "log_message_id" = 'legacy:' || "id"::text WHERE "log_message_id" IS NULL;--> statement-breakpoint
ALTER TABLE "fine_payment_proofs" ALTER COLUMN "log_message_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fines" ADD COLUMN "request_id" text;--> statement-breakpoint
UPDATE "fines" SET "request_id" = 'legacy:' || "id"::text WHERE "request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "fines" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fines" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
ALTER TABLE "fines" ADD COLUMN "public_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "fine_payment_proofs_guild_request_uq" ON "fine_payment_proofs" USING btree ("guild_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fines_guild_request_uq" ON "fines" USING btree ("guild_id","request_id");
