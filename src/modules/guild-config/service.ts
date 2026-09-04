import { eq } from 'drizzle-orm';
import type { Database } from '../../infrastructure/db/client.js';
import { guildSettings, type GuildSettings } from '../../infrastructure/db/schema.js';

export type ConfigurableChannel =
  | 'controlChannelId'
  | 'memberChannelId'
  | 'registrationRequestChannelId'
  | 'memberRosterChannelId'
  | 'activityChannelId'
  | 'activityLogChannelId'
  | 'attendanceChannelId'
  | 'attendanceLogChannelId'
  | 'leaveChannelId'
  | 'leaveLogChannelId'
  | 'fineChannelId'
  | 'fineLogChannelId'
  | 'treasuryChannelId'
  | 'treasuryWithdrawalChannelId'
  | 'treasuryWithdrawalLogChannelId'
  | 'weeklyDuesChannelId'
  | 'weeklyDuesLogChannelId'
  | 'stockChannelId'
  | 'stockLogChannelId'
  | 'withdrawalLogChannelId'
  | 'depositLogChannelId'
  | 'fightPositionChannelId'
  | 'auditChannelId';

export interface RoleSettingsInput {
  readonly devRoleId: string;
  readonly headRoleId: string;
  readonly deputyRoleId: string;
  readonly activeMemberRoleId: string;
  readonly formerMemberRoleId: string;
}

export class GuildConfigService {
  public constructor(private readonly db: Database) {}

  public async ensureGuild(guildId: string, timezone: string): Promise<void> {
    await this.db
      .insert(guildSettings)
      .values({ guildId, timezone })
      .onConflictDoNothing({ target: guildSettings.guildId });
  }

  public async get(guildId: string): Promise<GuildSettings | null> {
    const [settings] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
    return settings ?? null;
  }

  public async configureRoles(guildId: string, roles: RoleSettingsInput): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ ...roles, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async configureChannel(guildId: string, field: ConfigurableChannel, channelId: string): Promise<void> {
    if (field === 'memberRosterChannelId') {
      await this.db
        .update(guildSettings)
        .set({ memberRosterChannelId: channelId, memberRosterMessageId: null, updatedAt: new Date() })
        .where(eq(guildSettings.guildId, guildId));
      return;
    }
    if (field === 'stockChannelId') {
      await this.db
        .update(guildSettings)
        .set({ stockChannelId: channelId, stockPanelMessageId: null, updatedAt: new Date() })
        .where(eq(guildSettings.guildId, guildId));
      return;
    }
    if (field === 'stockLogChannelId') {
      await this.db
        .update(guildSettings)
        .set({ stockLogChannelId: channelId, stockLogDashboardMessageId: null, updatedAt: new Date() })
        .where(eq(guildSettings.guildId, guildId));
      return;
    }
    if (field === 'treasuryWithdrawalChannelId') {
      await this.db
        .update(guildSettings)
        .set({
          treasuryWithdrawalChannelId: channelId,
          treasuryWithdrawalPanelMessageId: null,
          updatedAt: new Date(),
        })
        .where(eq(guildSettings.guildId, guildId));
      return;
    }
    if (field === 'fightPositionChannelId') {
      await this.db
        .update(guildSettings)
        .set({
          fightPositionChannelId: channelId,
          fightPositionSummaryMessageId: null,
          updatedAt: new Date(),
        })
        .where(eq(guildSettings.guildId, guildId));
      return;
    }
    await this.db
      .update(guildSettings)
      .set({ [field]: channelId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveControlPanelMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ controlPanelMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveLeavePanelMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ leavePanelMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveTreasuryPanelMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ treasuryPanelMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveTreasuryWithdrawalPanelMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ treasuryWithdrawalPanelMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveStockPanelMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ stockPanelMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveStockLogDashboardMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ stockLogDashboardMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveMemberRosterMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ memberRosterMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }

  public async saveFightPositionSummaryMessage(guildId: string, messageId: string): Promise<void> {
    await this.db
      .update(guildSettings)
      .set({ fightPositionSummaryMessageId: messageId, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId));
  }
}
