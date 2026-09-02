ALTER TABLE "fight_positions" ADD COLUMN "emoji" text DEFAULT '⚔️' NOT NULL;--> statement-breakpoint
ALTER TABLE "fight_positions" ADD CONSTRAINT "fight_positions_emoji_not_blank" CHECK (length(trim("fight_positions"."emoji")) > 0);--> statement-breakpoint
UPDATE "fight_positions"
SET "sort_order" = "sort_order" + 8;--> statement-breakpoint
WITH "default_positions" ("name", "emoji", "sort_order") AS (
	VALUES
		('ปืน', '🔫', 0),
		('ไม้หน้า', '⚔️', 1),
		('ไม้กลาง', '🎯', 2),
		('ซัพพอตหลังบ้าน', '🩹', 3),
		('ปีกซ้าย', '🪽', 4),
		('ปีกขวา', '🪽', 5),
		('หลังบ้าน', '🛡️', 6),
		('อิสระ', '🕊️', 7)
)
INSERT INTO "fight_positions" ("guild_id", "name", "emoji", "is_active", "sort_order")
SELECT "guild_settings"."guild_id", "default_positions"."name", "default_positions"."emoji", true, "default_positions"."sort_order"
FROM "guild_settings"
CROSS JOIN "default_positions"
ON CONFLICT ("guild_id", "name") DO UPDATE
SET
	"emoji" = EXCLUDED."emoji",
	"is_active" = true,
	"sort_order" = EXCLUDED."sort_order",
	"updated_at" = now();
