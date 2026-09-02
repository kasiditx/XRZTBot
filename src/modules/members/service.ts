import { and, eq, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Database } from '../../infrastructure/db/client.js';
import {
  guildSettings,
  memberFightPositions,
  members,
  scheduledJobs,
  type Member,
} from '../../infrastructure/db/schema.js';
import { writeAudit } from '../audit/service.js';

export interface MemberRoleSyncPayload {
  readonly discordUserId: string;
  readonly addRoleId: string;
  readonly removeRoleId: string;
}

export interface MemberRoleIds {
  readonly headRoleId: string;
  readonly deputyRoleId: string;
  readonly activeMemberRoleId: string;
  readonly formerMemberRoleId: string;
}

export type RegistrationEligibility = 'ELIGIBLE' | 'PENDING' | 'ACTIVE';
export type MemberRosterTitle = NonNullable<Member['rosterTitle']>;

export class MemberService {
  public constructor(private readonly db: Database) {}

  public async register(guildId: string, discordUserId: string, inGameName: string): Promise<Member> {
    const normalizedName = inGameName.trim();
    if (normalizedName.length < 2 || normalizedName.length > 80) {
      throw new ValidationError('ชื่อในเมืองต้องมี 2–80 ตัวอักษร');
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(members)
        .where(and(eq(members.guildId, guildId), eq(members.discordUserId, discordUserId)))
        .limit(1)
        .for('update');

      if (existing?.status === 'ACTIVE') {
        throw new ConflictError('คุณเป็นสมาชิกที่ใช้งานอยู่แล้ว');
      }
      if (existing?.status === 'PENDING') {
        throw new ConflictError('คำขอลงทะเบียนของคุณกำลังรออนุมัติ');
      }

      const now = new Date();
      const [saved] = existing === undefined
        ? await tx
            .insert(members)
            .values({ guildId, discordUserId, inGameName: normalizedName })
            .returning()
        : await tx
            .update(members)
            .set({
              inGameName: normalizedName,
              status: 'PENDING',
              requestedAt: now,
              decidedAt: null,
              decidedByDiscordUserId: null,
              departureReason: null,
              registrationRequestChannelId: null,
              registrationRequestMessageId: null,
              updatedAt: now,
            })
            .where(eq(members.id, existing.id))
            .returning();

      if (saved === undefined) {
        throw new Error('Member registration did not return a row');
      }

      await writeAudit(tx, {
        guildId,
        actorDiscordUserId: discordUserId,
        action: 'MEMBER_REGISTERED',
        entityType: 'MEMBER',
        entityId: saved.id,
        before: existing ?? null,
        after: saved,
      });
      await queueRegistrationRequestSync(tx, guildId, saved.id);

      return saved;
    });
  }

  public async getRegistrationEligibility(guildId: string, discordUserId: string): Promise<RegistrationEligibility> {
    const member = await this.findByDiscordUserId(guildId, discordUserId);
    if (member?.status === 'PENDING') return 'PENDING';
    if (member?.status === 'ACTIVE') return 'ACTIVE';
    return 'ELIGIBLE';
  }

  public async approve(
    guildId: string,
    memberId: string,
    actorDiscordUserId: string,
    roleIds: MemberRoleIds,
  ): Promise<Member> {
    return this.changeMembershipStatus(guildId, memberId, actorDiscordUserId, 'ACTIVE', roleIds);
  }

  public async addDirectly(
    guildId: string,
    discordUserId: string,
    inGameName: string,
    actorDiscordUserId: string,
    roleIds: MemberRoleIds,
  ): Promise<Member> {
    const normalizedName = inGameName.trim();
    if (normalizedName.length < 2 || normalizedName.length > 80) {
      throw new ValidationError('ชื่อในเมืองต้องมี 2–80 ตัวอักษร');
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(members)
        .where(and(eq(members.guildId, guildId), eq(members.discordUserId, discordUserId)))
        .limit(1)
        .for('update');

      if (existing?.status === 'ACTIVE') {
        throw new ConflictError('บุคคลนี้เป็นสมาชิกที่ใช้งานอยู่แล้ว');
      }

      const now = new Date();
      const [saved] = existing === undefined
        ? await tx
            .insert(members)
            .values({
              guildId,
              discordUserId,
              inGameName: normalizedName,
              status: 'ACTIVE',
              decidedAt: now,
              decidedByDiscordUserId: actorDiscordUserId,
            })
            .returning()
        : await tx
            .update(members)
            .set({
              inGameName: normalizedName,
              status: 'ACTIVE',
              requestedAt: now,
              decidedAt: now,
              decidedByDiscordUserId: actorDiscordUserId,
              departureReason: null,
              updatedAt: now,
            })
            .where(eq(members.id, existing.id))
            .returning();

      if (saved === undefined) {
        throw new Error('Direct member creation did not return a row');
      }

      await queueRoleSync(tx, guildId, discordUserId, roleIds.activeMemberRoleId, roleIds.formerMemberRoleId, saved.id);
      await queueMemberRosterRefresh(tx, guildId, saved.id);
      await queueFightPositionRefresh(tx, guildId, saved.id);
      await queueRegistrationRequestSync(tx, guildId, saved.id);
      await writeAudit(tx, {
        guildId,
        actorDiscordUserId,
        action: 'MEMBER_ADDED_DIRECTLY',
        entityType: 'MEMBER',
        entityId: saved.id,
        before: existing ?? null,
        after: saved,
      });
      return saved;
    });
  }

  public async reject(guildId: string, memberId: string, actorDiscordUserId: string, reason: string): Promise<Member> {
    const normalizedReason = requireReason(reason);
    return this.db.transaction(async (tx) => {
      const member = await lockMember(tx, guildId, memberId);
      if (member.status !== 'PENDING') {
        throw new ConflictError('อนุมัติหรือปฏิเสธได้เฉพาะคำขอที่กำลังรออนุมัติ');
      }

      const [updated] = await tx
        .update(members)
        .set({
          status: 'REJECTED',
          decidedAt: new Date(),
          decidedByDiscordUserId: actorDiscordUserId,
          departureReason: normalizedReason,
          updatedAt: new Date(),
        })
        .where(eq(members.id, member.id))
        .returning();

      if (updated === undefined) {
        throw new Error('Member rejection did not return a row');
      }
      await writeMemberAudit(tx, guildId, actorDiscordUserId, 'MEMBER_REJECTED', member, updated, normalizedReason);
      await queueRegistrationRequestSync(tx, guildId, member.id);
      return updated;
    });
  }

  public async markFormer(
    guildId: string,
    discordUserId: string,
    actorDiscordUserId: string,
    reason: string,
    roleIds: MemberRoleIds,
  ): Promise<Member> {
    const normalizedReason = requireReason(reason);

    return this.db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(members)
        .where(and(eq(members.guildId, guildId), eq(members.discordUserId, discordUserId)))
        .limit(1)
        .for('update');

      if (member === undefined) {
        throw new NotFoundError('ไม่พบสมาชิกคนนี้ในทะเบียน');
      }
      if (member.status !== 'ACTIVE') {
        throw new ConflictError('เปลี่ยนสถานะออกได้เฉพาะสมาชิกที่ใช้งานอยู่');
      }

      const [updated] = await tx
        .update(members)
        .set({ status: 'FORMER', rosterTitle: null, departureReason: normalizedReason, updatedAt: new Date() })
        .where(eq(members.id, member.id))
        .returning();

      if (updated === undefined) {
        throw new Error('Member departure did not return a row');
      }

      const [removedFightAssignment] = await tx
        .delete(memberFightPositions)
        .where(and(
          eq(memberFightPositions.guildId, guildId),
          eq(memberFightPositions.memberId, member.id),
        ))
        .returning();
      if (removedFightAssignment !== undefined) {
        await writeAudit(tx, {
          guildId,
          actorDiscordUserId,
          action: 'MEMBER_FIGHT_POSITION_CLEARED',
          entityType: 'MEMBER_FIGHT_POSITION',
          entityId: member.id,
          reason: 'สมาชิกออกจากแก๊ง',
          before: removedFightAssignment,
          after: null,
        });
      }

      await queueRoleSync(tx, guildId, member.discordUserId, roleIds.formerMemberRoleId, roleIds.activeMemberRoleId, member.id);
      await queueAdminRoleSync(tx, guildId, member.discordUserId, null, roleIds, member.id);
      await queueMemberRosterRefresh(tx, guildId, member.id);
      await queueFightPositionRefresh(tx, guildId, member.id);
      await queueRegistrationRequestSync(tx, guildId, member.id);
      await writeMemberAudit(tx, guildId, actorDiscordUserId, 'MEMBER_MARKED_FORMER', member, updated, normalizedReason);
      return updated;
    });
  }

  public async listPending(guildId: string, limit = 25): Promise<Member[]> {
    return this.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.status, 'PENDING')))
      .orderBy(members.requestedAt)
      .limit(limit);
  }

  public async queuePendingRegistrationRequestSync(guildId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const pendingMembers = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.guildId, guildId), eq(members.status, 'PENDING')));
      if (pendingMembers.length === 0) return 0;

      await tx.insert(scheduledJobs).values(
        pendingMembers.map(({ id }) => ({
          guildId,
          jobType: 'MEMBER_REGISTRATION_REQUEST_SYNC',
          deduplicationKey: `member-registration-request-sync:${id}:${crypto.randomUUID()}`,
          payload: { memberId: id },
          runAt: new Date(),
        })),
      );
      return pendingMembers.length;
    });
  }

  public async listActive(guildId: string): Promise<Member[]> {
    return this.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.status, 'ACTIVE')))
      .orderBy(
        sql`case ${members.rosterTitle}
          when 'HEAD' then 1
          when 'DEPUTY' then 2
          when 'ACCOUNTANT' then 3
          else 4
        end`,
        members.inGameName,
      );
  }

  public async assignRosterTitle(
    guildId: string,
    memberId: string,
    title: MemberRosterTitle | null,
    actorDiscordUserId: string,
    roleIds: MemberRoleIds,
  ): Promise<Member> {
    return this.db.transaction(async (tx) => {
      await lockMemberRosterGuild(tx, guildId);
      const member = await lockMember(tx, guildId, memberId);
      if (member.status !== 'ACTIVE') {
        throw new ConflictError('กำหนดตำแหน่งกำกับได้เฉพาะสมาชิกที่ใช้งานอยู่');
      }

      const now = new Date();
      let displacedMembers: Member[] = [];
      if (title === 'HEAD' || title === 'ACCOUNTANT') {
        displacedMembers = await tx
          .select()
          .from(members)
          .where(and(eq(members.guildId, guildId), eq(members.rosterTitle, title)))
          .for('update');
        await tx
          .update(members)
          .set({ rosterTitle: null, updatedAt: now })
          .where(and(eq(members.guildId, guildId), eq(members.rosterTitle, title)));
        for (const previous of displacedMembers) {
          if (previous.id === member.id) continue;
          await writeMemberAudit(
            tx,
            guildId,
            actorDiscordUserId,
            'MEMBER_ROSTER_TITLE_REPLACED',
            previous,
            { ...previous, rosterTitle: null, updatedAt: now },
          );
        }
      }

      const [updated] = await tx
        .update(members)
        .set({ rosterTitle: title, updatedAt: now })
        .where(and(eq(members.guildId, guildId), eq(members.id, member.id)))
        .returning();
      if (updated === undefined) throw new Error('Roster title assignment did not return a row');

      await writeMemberAudit(tx, guildId, actorDiscordUserId, 'MEMBER_ROSTER_TITLE_ASSIGNED', member, updated);
      await queueMemberRosterRefresh(tx, guildId, member.id);
      await queueAdminRoleSync(tx, guildId, updated.discordUserId, title, roleIds, updated.id);
      for (const previous of title === 'HEAD' || title === 'ACCOUNTANT' ? displacedMembers : []) {
        if (previous.id === member.id) continue;
        await queueAdminRoleSync(tx, guildId, previous.discordUserId, null, roleIds, previous.id);
      }
      return updated;
    });
  }

  public async findById(guildId: string, memberId: string): Promise<Member | null> {
    const [member] = await this.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.id, memberId)))
      .limit(1);
    return member ?? null;
  }

  public async findByDiscordUserId(guildId: string, discordUserId: string): Promise<Member | null> {
    const [member] = await this.db
      .select()
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.discordUserId, discordUserId)))
      .limit(1);
    return member ?? null;
  }

  public async markRegistrationRequestPublished(
    guildId: string,
    memberId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.db
      .update(members)
      .set({
        registrationRequestChannelId: channelId,
        registrationRequestMessageId: messageId,
        updatedAt: new Date(),
      })
      .where(and(eq(members.guildId, guildId), eq(members.id, memberId)));
  }

  private async changeMembershipStatus(
    guildId: string,
    memberId: string,
    actorDiscordUserId: string,
    targetStatus: 'ACTIVE',
    roleIds: MemberRoleIds,
  ): Promise<Member> {
    return this.db.transaction(async (tx) => {
      const member = await lockMember(tx, guildId, memberId);
      if (member.status !== 'PENDING') {
        throw new ConflictError('อนุมัติได้เฉพาะคำขอที่กำลังรออนุมัติ');
      }

      const [updated] = await tx
        .update(members)
        .set({
          status: targetStatus,
          decidedAt: new Date(),
          decidedByDiscordUserId: actorDiscordUserId,
          departureReason: null,
          updatedAt: new Date(),
        })
        .where(eq(members.id, member.id))
        .returning();

      if (updated === undefined) {
        throw new Error('Member approval did not return a row');
      }

      await queueRoleSync(tx, guildId, member.discordUserId, roleIds.activeMemberRoleId, roleIds.formerMemberRoleId, member.id);
      await queueMemberRosterRefresh(tx, guildId, member.id);
      await queueFightPositionRefresh(tx, guildId, member.id);
      await queueRegistrationRequestSync(tx, guildId, member.id);
      await writeMemberAudit(tx, guildId, actorDiscordUserId, 'MEMBER_APPROVED', member, updated);
      return updated;
    });
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function lockMember(tx: Transaction, guildId: string, memberId: string): Promise<Member> {
  const [member] = await tx
    .select()
    .from(members)
    .where(and(eq(members.guildId, guildId), eq(members.id, memberId)))
    .limit(1)
    .for('update');

  if (member === undefined) {
    throw new NotFoundError('ไม่พบสมาชิก');
  }
  return member;
}

async function lockMemberRosterGuild(tx: Transaction, guildId: string): Promise<void> {
  const [guild] = await tx
    .select({ guildId: guildSettings.guildId })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .limit(1)
    .for('update');
  if (guild === undefined) throw new NotFoundError('ไม่พบการตั้งค่า Server');
}

async function queueRoleSync(
  tx: Transaction,
  guildId: string,
  discordUserId: string,
  addRoleId: string,
  removeRoleId: string,
  memberId: string,
): Promise<void> {
  const payload: MemberRoleSyncPayload = { discordUserId, addRoleId, removeRoleId };
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'MEMBER_ROLE_SYNC',
    deduplicationKey: `member-role-sync:${memberId}:${crypto.randomUUID()}`,
    payload: { ...payload },
    runAt: new Date(),
  });
}

async function queueAdminRoleSync(
  tx: Transaction,
  guildId: string,
  discordUserId: string,
  title: MemberRosterTitle | null,
  roleIds: MemberRoleIds,
  memberId: string,
): Promise<void> {
  const desiredRole = title === 'HEAD' || title === 'DEPUTY' ? title : null;
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'MEMBER_ADMIN_ROLE_SYNC',
    deduplicationKey: `member-admin-role-sync:${memberId}:${crypto.randomUUID()}`,
    payload: {
      discordUserId,
      headRoleId: roleIds.headRoleId,
      deputyRoleId: roleIds.deputyRoleId,
      desiredRole,
    },
    runAt: new Date(),
  });
}

async function queueMemberRosterRefresh(tx: Transaction, guildId: string, memberId: string): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'MEMBER_ROSTER_REFRESH',
    deduplicationKey: `member-roster-refresh:${memberId}:${crypto.randomUUID()}`,
    payload: {},
    runAt: new Date(),
  });
}

async function queueFightPositionRefresh(tx: Transaction, guildId: string, memberId: string): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'FIGHT_POSITION_REFRESH',
    deduplicationKey: `fight-position-refresh:${memberId}:${crypto.randomUUID()}`,
    payload: {},
    runAt: new Date(),
  });
}

async function queueRegistrationRequestSync(tx: Transaction, guildId: string, memberId: string): Promise<void> {
  await tx.insert(scheduledJobs).values({
    guildId,
    jobType: 'MEMBER_REGISTRATION_REQUEST_SYNC',
    deduplicationKey: `member-registration-request-sync:${memberId}:${crypto.randomUUID()}`,
    payload: { memberId },
    runAt: new Date(),
  });
}

async function writeMemberAudit(
  tx: Transaction,
  guildId: string,
  actorDiscordUserId: string,
  action: string,
  before: Member,
  after: Member,
  reason?: string,
): Promise<void> {
  await writeAudit(tx, {
    guildId,
    actorDiscordUserId,
    action,
    entityType: 'MEMBER',
    entityId: before.id,
    before,
    after,
    ...(reason === undefined ? {} : { reason }),
  });
}

function requireReason(reason: string): string {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 2 || normalizedReason.length > 500) {
    throw new ValidationError('เหตุผลต้องมี 2–500 ตัวอักษร');
  }
  return normalizedReason;
}
