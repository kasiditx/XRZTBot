CREATE TABLE "leave_schedule_scopes" (
	"leave_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	CONSTRAINT "leave_schedule_scopes_leave_id_schedule_id_pk" PRIMARY KEY("leave_id","schedule_id")
);
--> statement-breakpoint
ALTER TABLE "leaves" ADD COLUMN "all_rounds" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_schedule_scopes" ADD CONSTRAINT "leave_schedule_scopes_leave_id_leaves_id_fk" FOREIGN KEY ("leave_id") REFERENCES "public"."leaves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_schedule_scopes" ADD CONSTRAINT "leave_schedule_scopes_schedule_id_attendance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."attendance_schedules"("id") ON DELETE cascade ON UPDATE no action;
