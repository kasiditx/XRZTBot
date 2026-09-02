import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  fightPositions,
  guildSettings,
  memberFightPositions,
  members,
  scheduledJobs,
  type FightPosition,
  type Member,
  type MemberFightPosition,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';

export interface FightPositionRosterEntry {
  readonly memberId: string;
  readonly discordUserId: string;
  readonly inGameName: string;
  readonly positionId: string | null;
  readonly positionName: string | null;
  readonly positionSortOrder: number | null;
}

export interface FightPositionAssignmentResult {
  readonly member: Member;
  readonly position: FightPosition | null;
}

export class FightPositionService {
  public constructor(private readonly db: Database) {}

  public async listActive(guildId: string): Promise<FightPosition[]> {
    return this.db
      .select()
      .from(fightPositions)
      .where(and(eq(fightPositions.guildId, guildId), eq(fightPositions.isActive, true)))
      .orderBy(asc(fightPositions.sortOrder), asc(fightPositions.name));
  }

  public async getActive(guildId: string, positionId: string): Promise<FightPosition> {
    const [position] = await this.db
      .select()
      .from(fightPositions)
      .where(and(
        eq(fightPositions.guildId, guildId),
        eq(fightPositions.id, positionId),
        eq(fightPositions.isActive, true),
      ))
      .limit(1);
    if (position === undefined) throw new NotFoundError('ไม่พบตำแหน่ง Fight นี้');
    return position;
  }

  public async listRoster(guildId: string): Promise<FightPositionRosterEntry[]> {
    return this.db
      .select({
        memberId: members.id,
        discordUserId: members.discordUserId,
        inGameName: members.inGameName,
        positionId: fightPositions.id,
        positionName: fightPositions.name,
        positionSortOrder: fightPositions.sortOrder,
      })
      .from(members)
      .leftJoin(
        memberFightPositions,
        and(
          eq(memberFightPositions.guildId, guildId),
          eq(memberFightPositions.memberId, members.id),
        ),
      )
      .leftJoin(
        fightPositions,
        and(
          eq(fightPositions.guildId, guildId),
          eq(fightPositions.id, memberFightPositions.positionId),
          eq(fightPositions.isActive, true),
        ),
      )
      .where(and(eq(members.guildId, guildId), eq(members.status, 'ACTIVE')))
      .orderBy(
        sql`case when ${fightPositions.id} is null then 1 else 0 end`,
        asc(fightPositions.sortOrder),
        asc(fightPositions.name),
        asc(members.inGameName),
      );
  }

  public async listUnassignedMembers(guildId: string): Promise<Member[]> {
    return this.db
      .select({ member: members })
      .from(members)
      .leftJoin(
        memberFightPositions,
        and(
          eq(memberFightPositions.guildId, guildId),
          eq(memberFightPositions.memberId, members.id),
        ),
      )
      .where(and(
        eq(members.guildId, guildId),
        eq(members.status, 'ACTIVE'),
        isNull(memberFightPositions.memberId),
      ))
      .orderBy(asc(members.inGameName))
      .then((rows) => rows.map(({ member }) => member));
  }

  public async listAssignedMembers(guildId: string): Promise<Member[]> {
    return this.db
      .select({ member: members })
      .from(members)
      .innerJoin(
        memberFightPositions,
        and(
          eq(memberFightPositions.guildId, guildId),
          eq(memberFightPositions.memberId, members.id),
        ),
      )
      .innerJoin(
        fightPositions,
        and(
          eq(fightPositions.guildId, guildId),
          eq(fightPositions.id, memberFightPositions.positionId),
          eq(fightPositions.isActive, true),
        ),
      )
      .where(and(eq(members.guildId, guildId), eq(members.status, 'ACTIVE')))
      .orderBy(asc(members.inGameName))
      .then((rows) => rows.map(({ member }) => member));
  }

  public async create(guildId: string, name: string, actorDiscordUserId: string): Promise<FightPosition> {
    const normalizedName = normalizeName(name);
    return this.db.transaction(async (tx) => {
      await lockGuild(tx, guildId);
      const [existing] = await tx
        .select()
        .from(fightPositions)
        .where(and(eq(fightPositions.guildId, guildId), eq(fightPositions.name, normalizedName)))
        .limit(1)
        .for('update');

      if (existing?.isActive === true) {
        throw new ConflictError('มีตำแหน่ง Fight ชื่อนี้อยู่แล้ว');
      }

      const nextSortOrder = await findNextSortOrder(tx, guildId);
      const [saved] = existing === undefined
        ? await tx
            .insert(fightPositions)
            .values({ guildId, name: normalizedName, sortOrder: nextSortOrder })
            .returning()
        : await tx
            .update(fightPositions)
            .set({ isActive: true, sortOrder: nextSortOrder, updatedAt: new Date() })
            .where(eq(fightPositions.id, existing.id))
            .returning();
      if (saved === undefined) throw new Error('Fight position creation did not return a row');

      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: existing === undefined ? 'FIGHT_POSITION_CREATED' : 'FIGHT_POSITION_REACTIVATED',
        entityType: 'FIGHT_POSITION',
        entityId: saved.id,
        before: existing ?? null,
        after: saved,
      });
      await queueSummaryRefresh(tx, guildId, saved.id);
      return saved;
    });
  }

  public async rename(
    guildId: string,
    positionId: string,
    name: string,
    actorDiscordUserId: string,
  ): Promise<FightPosition> {
    const normalizedName = normalizeName(name);
    return this.db.transaction(async (tx) => {
      await lockGuild(tx, guildId);
      const position = await lockActivePosition(tx, guildId, positionId);
      if (position.name === normalizedName) return position;

      const [duplicate] = await tx
        .select({ id: fightPositions.id })
        .from(fightPositions)
        .where(and(
          eq(fightPositions.guildId, guildId),
          eq(fightPositions.name, normalizedName),
          ne(fightPositions.id, position.id),
        ))
        .limit(1);
      if (duplicate !== undefined) throw new ConflictError('มีตำแหน่ง Fight ชื่อนี้อยู่แล้ว');

      const [updated] = await tx
        .update(fightPositions)
        .set({ name: normalizedName, updatedAt: new Date() })
        .where(eq(fightPositions.id, position.id))
        .returning();
      if (updated === undefined) throw new Error('Fight position rename did not return a row');

      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'FIGHT_POSITION_RENAMED',
        entityType: 'FIGHT_POSITION',
        entityId: updated.id,
        before: position,
        after: updated,
      });
      await queueSummaryRefresh(tx, guildId, updated.id);
      return updated;
    });
  }

  public async remove(guildId: string, positionId: string, actorDiscordUserId: string): Promise<FightPosition> {
    return this.db.transaction(async (tx) => {
      await lockGuild(tx, guildId);
      const position = await lockActivePosition(tx, guildId, positionId);
      const clearedAssignments = await tx
        .delete(memberFightPositions)
        .where(and(
          eq(memberFightPositions.guildId, guildId),
          eq(memberFightPositions.positionId, position.id),
        ))
        .returning({ memberId: memberFightPositions.memberId });
      const [removed] = await tx
        .update(fightPositions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(fightPositions.id, position.id))
        .returning();
      if (removed === undefined) throw new Error('Fight position removal did not return a row');

      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'FIGHT_POSITION_REMOVED',
        entityType: 'FIGHT_POSITION',
        entityId: removed.id,
        reason: `ล้างการมอบตำแหน่ง ${clearedAssignments.length.toString()} คน`,
        before: position,
        after: removed,
      });
      await queueSummaryRefresh(tx, guildId, removed.id);
      return removed;
    });
  }

  public async assign(
    guildId: string,
    memberId: string,
    positionId: string | null,
    actorDiscordUserId: string,
  ): Promise<FightPositionAssignmentResult> {
    return this.db.transaction(async (tx) => {
      await lockGuild(tx, guildId);
      const member = await lockActiveMember(tx, guildId, memberId);
      const [existing] = await tx
        .select()
        .from(memberFightPositions)
        .where(and(
          eq(memberFightPositions.guildId, guildId),
          eq(memberFightPositions.memberId, member.id),
        ))
        .limit(1)
        .for('update');

      if (positionId === null) {
        if (existing === undefined) return { member, position: null };
        await tx
          .delete(memberFightPositions)
          .where(and(
            eq(memberFightPositions.guildId, guildId),
            eq(memberFightPositions.memberId, member.id),
          ));
        await writeAssignmentAudit(tx, guildId, actorDiscordUserId, member.id, existing, null);
        await queueSummaryRefresh(tx, guildId, member.id);
        return { member, position: null };
      }

      const position = await lockActivePosition(tx, guildId, positionId);
      if (existing?.positionId === position.id) return { member, position };
      const now = new Date();
      const [saved] = await tx
        .insert(memberFightPositions)
        .values({
          guildId,
          memberId: member.id,
          positionId: position.id,
          assignedByDiscordUserId: actorDiscordUserId,
          assignedAt: now,
        })
        .onConflictDoUpdate({
          target: [memberFightPositions.guildId, memberFightPositions.memberId],
          set: {
            positionId: position.id,
            assignedByDiscordUserId: actorDiscordUserId,
            assignedAt: now,
          },
        })
        .returning();
      if (saved === undefined) throw new Error('Fight position assignment did not return a row');

      await writeAssignmentAudit(tx, guildId, actorDiscordUserId, member.id, existing ?? null, saved);
      await queueSummaryRefresh(tx, guildId, member.id);
      return { member, position };
    });
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 2 || normalized.length > 80) {
    throw new ValidationError('ชื่อตำแหน่ง Fight ต้องมี 2–80 ตัวอักษร');
  }
  return normalized;
}

async function lockGuild(tx: Transaction, guildId: string): Promise<void> {
  const [guild] = await tx
    .select({ guildId: guildSettings.guildId })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .limit(1)
    .for('update');
  if (guild === undefined) throw new NotFoundError('ไม่พบการตั้งค่า Server');
}

async function lockActiveMember(tx: Transaction, guildId: string, memberId: string): Promise<Member> {
  const [member] = await tx
    .select()
    .from(members)
    .where(and(eq(members.guildId, guildId), eq(members.id, memberId)))
    .limit(1)
    .for('update');
  if (member === undefined) throw new NotFoundError('ไม่พบสมาชิก');
  if (member.status !== 'ACTIVE') throw new ConflictError('กำหนดตำแหน่งได้เฉพาะสมาชิกที่ใช้งานอยู่');
  return member;
}

async function lockActivePosition(tx: Transaction, guildId: string, positionId: string): Promise<FightPosition> {
  const [position] = await tx
    .select()
    .from(fightPositions)
    .where(and(eq(fightPositions.guildId, guildId), eq(fightPositions.id, positionId)))
    .limit(1)
    .for('update');
  if (position === undefined || !position.isActive) throw new NotFoundError('ไม่พบตำแหน่ง Fight นี้');
  return position;
}

async function findNextSortOrder(tx: Transaction, guildId: string): Promise<number> {
  const [result] = await tx
    .select({ value: sql<number>`coalesce(max(${fightPositions.sortOrder}), -1) + 1` })
    .from(fightPositions)
    .where(and(eq(fightPositions.guildId, guildId), eq(fightPositions.isActive, true)));
  return result?.value ?? 0;
}

async function writeAssignmentAudit(
  tx: Transaction,
  guildId: string,
  actorDiscordUserId: string,
  memberId: string,
  before: MemberFightPosition | null,
  after: MemberFightPosition | null,
): Promise<void> {
  await writeAudit(tx, {
    guildId,
    actorDiscordUserId,
    action: after === null ? 'MEMBER_FIGHT_POSITION_CLEARED' : 'MEMBER_FIGHT_POSITION_ASSIGNED',
    entityType: 'MEMBER_FIGHT_POSITION',
    entityId: memberId,
    before,
    after,
  });
}

async function queueSummaryRefresh(tx: Transaction, guildId: string, entityId: string): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'FIGHT_POSITION_REFRESH',
    deduplicationKey: `fight-position-refresh:${entityId}:${crypto.randomUUID()}`,
    payload: {},
    runAt: new Date(),
  });
}
