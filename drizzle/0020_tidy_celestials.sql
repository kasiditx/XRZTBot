ALTER TYPE "public"."member_roster_title" ADD VALUE 'RESERVE';--> statement-breakpoint
CREATE TABLE "fight_position_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fight_position_sets_name_not_blank" CHECK (length(trim("fight_position_sets"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "fight_position_sets" ADD CONSTRAINT "fight_position_sets_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fight_position_sets_guild_name_uq" ON "fight_position_sets" USING btree ("guild_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fight_position_sets_guild_id_uq" ON "fight_position_sets" USING btree ("guild_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fight_position_sets_guild_active_uq" ON "fight_position_sets" USING btree ("guild_id") WHERE "fight_position_sets"."is_active" = true;--> statement-breakpoint
CREATE INDEX "fight_position_sets_guild_sort_idx" ON "fight_position_sets" USING btree ("guild_id","sort_order");--> statement-breakpoint
INSERT INTO "fight_position_sets" ("guild_id", "name", "is_active", "sort_order")
SELECT "guild_id", 'Set 1', true, 0
FROM "guild_settings";--> statement-breakpoint
ALTER TABLE "member_fight_positions" ADD COLUMN "set_id" uuid;--> statement-breakpoint
UPDATE "member_fight_positions" AS "assignment"
SET "set_id" = "fight_set"."id"
FROM "fight_position_sets" AS "fight_set"
WHERE "fight_set"."guild_id" = "assignment"."guild_id"
  AND "fight_set"."is_active" = true;--> statement-breakpoint
ALTER TABLE "member_fight_positions" ALTER COLUMN "set_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "member_fight_positions" DROP CONSTRAINT "member_fight_positions_guild_id_member_id_pk";--> statement-breakpoint
ALTER TABLE "member_fight_positions" ADD CONSTRAINT "member_fight_positions_guild_id_set_id_member_id_pk" PRIMARY KEY("guild_id","set_id","member_id");--> statement-breakpoint
ALTER TABLE "member_fight_positions" ADD CONSTRAINT "member_fight_positions_set_fk" FOREIGN KEY ("guild_id","set_id") REFERENCES "public"."fight_position_sets"("guild_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_fight_positions_set_idx" ON "member_fight_positions" USING btree ("guild_id","set_id");
