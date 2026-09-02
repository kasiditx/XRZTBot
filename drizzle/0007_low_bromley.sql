ALTER TABLE "deposit_requests" ADD COLUMN "client_request_id" text;--> statement-breakpoint
UPDATE "deposit_requests" SET "client_request_id" = 'legacy:' || "id"::text WHERE "client_request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "deposit_requests" ALTER COLUMN "client_request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_requests" ADD COLUMN "public_channel_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_requests_guild_client_request_uq" ON "deposit_requests" USING btree ("guild_id","client_request_id");
