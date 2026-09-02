CREATE TYPE "public"."member_roster_title" AS ENUM('HEAD', 'DEPUTY', 'ACCOUNTANT');--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "roster_title" "member_roster_title";--> statement-breakpoint
CREATE UNIQUE INDEX "members_guild_singleton_roster_title_uq" ON "members" USING btree ("guild_id","roster_title") WHERE "members"."roster_title" in ('HEAD', 'ACCOUNTANT');