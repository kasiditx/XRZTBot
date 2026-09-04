CREATE TABLE "discord_log_day_markers" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"local_date" date NOT NULL,
	"separator_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_log_day_markers_guild_id_channel_id_local_date_pk" PRIMARY KEY("guild_id","channel_id","local_date")
);
--> statement-breakpoint
ALTER TABLE "discord_log_day_markers" ADD CONSTRAINT "discord_log_day_markers_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;