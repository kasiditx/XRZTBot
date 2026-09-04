import type pino from 'pino';
import {
  DiscordAPIError,
  MessageFlags,
  PermissionsBitField,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuthorizationError, DomainError, ValidationError } from '../../domain/errors.js';
import type { GuildSettings } from '../db/schema.js';
import { resolveAuthority, requireCapability, type AuthorityLevel, type Capability } from '../../modules/authorization/permissions.js';
import type { ConfigurableChannel, GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberRoleIds, MemberService } from '../../modules/members/service.js';
import type { ActivityInteractionHandler } from './activity-interaction-handler.js';
import type { AttendanceInteractionHandler } from './attendance-interaction-handler.js';
import type { FineInteractionHandler } from './fine-interaction-handler.js';
import type { TreasuryInteractionHandler } from './treasury-interaction-handler.js';
import type { WeeklyDuesInteractionHandler } from './weekly-dues-interaction-handler.js';
import type { StockInteractionHandler } from './stock-interaction-handler.js';
import type { FightPositionInteractionHandler } from './fight-position-interaction-handler.js';
import { listMissingBotChannelPermissions } from './channel-permissions.js';
import { commandNames } from './commands.js';
import {
  buildControlPanel,
  buildMemberRegistrationRequest,
  buildMemberRoster,
  buildMemberDecision,
  buildRegistrationModal,
  buildRegistrationPanel,
  buildRejectModal,
  buildRosterMemberSelector,
  buildRosterTitleSelector,
  componentIds,
  memberRosterMemberPagePrefix,
  memberRosterMemberSelectPrefix,
  memberRosterPagePrefix,
  memberRosterTitleSelectId,
  rosterTitleDisplay,
  type RosterTitleSelection,
} from './components.js';
import { buildNotice } from './theme.js';
import { filterRoleVerifiedActiveMembers } from './role-verified-members.js';

const channelFields: readonly ConfigurableChannel[] = [
  'controlChannelId',
  'memberChannelId',
  'registrationRequestChannelId',
  'memberRosterChannelId',
  'activityChannelId',
  'activityLogChannelId',
  'attendanceChannelId',
  'attendanceLogChannelId',
  'leaveChannelId',
  'leaveLogChannelId',
  'fineChannelId',
  'fineLogChannelId',
  'treasuryChannelId',
  'treasuryWithdrawalChannelId',
  'treasuryWithdrawalLogChannelId',
  'weeklyDuesChannelId',
  'weeklyDuesLogChannelId',
  'stockChannelId',
  'stockLogChannelId',
  'withdrawalLogChannelId',
  'depositLogChannelId',
  'fightPositionChannelId',
  'auditChannelId',
];

const DISCORD_MISSING_ACCESS_ERROR = 50_001;

export interface InteractionHandlerDependencies {
  readonly client: Client;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
  readonly activityInteractions: ActivityInteractionHandler;
  readonly attendanceInteractions: AttendanceInteractionHandler;
  readonly fineInteractions: FineInteractionHandler;
  readonly treasuryInteractions: TreasuryInteractionHandler;
  readonly weeklyDuesInteractions: WeeklyDuesInteractionHandler;
  readonly stockInteractions: StockInteractionHandler;
  readonly fightPositionInteractions: FightPositionInteractionHandler;
  readonly logger: pino.Logger;
  readonly checkDatabase: () => Promise<boolean>;
}

export class DiscordInteractionHandler {
  public constructor(private readonly dependencies: InteractionHandlerDependencies) {}

  public async handle(interaction: Interaction): Promise<void> {
    try {
      if (await this.dependencies.activityInteractions.handle(interaction)) {
        return;
      }
      if (await this.dependencies.attendanceInteractions.handle(interaction)) {
        return;
      }
      if (await this.dependencies.fineInteractions.handle(interaction)) {
        return;
      }
      if (await this.dependencies.treasuryInteractions.handle(interaction)) {
        return;
      }
      if (await this.dependencies.weeklyDuesInteractions.handle(interaction)) {
        return;
      }
      if (await this.dependencies.stockInteractions.handle(interaction)) {
        return;
      }
      if (await this.dependencies.fightPositionInteractions.handle(interaction)) {
        return;
      }
      if (interaction.isChatInputCommand()) {
        await this.handleCommand(interaction);
        return;
      }
      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        await this.handleSelect(interaction);
        return;
      }
      if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      }
    } catch (error: unknown) {
      await this.handleError(interaction, error);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === commandNames.register) {
      await this.showRegistrationModal(interaction, requireGuild(interaction.guild));
      return;
    }

    if (interaction.commandName !== commandNames.admin) {
      return;
    }

    const guild = requireGuild(interaction.guild);
    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case 'setup-roles':
        await this.setupRoles(interaction, guild);
        return;
      case 'set-channel':
        await this.setChannel(interaction, guild);
        return;
      case 'panel':
        await this.publishControlPanel(interaction, guild);
        return;
      case 'publish-registration':
        await this.publishRegistration(interaction, guild);
        return;
      case 'publish-member-roster':
        await this.publishMemberRoster(interaction, guild);
        return;
      case 'add-member':
        await this.addMember(interaction, guild);
        return;
      case 'remove-member':
        await this.removeMember(interaction, guild);
        return;
      case 'health':
        await this.showHealth(interaction, guild);
        return;
      default:
        throw new ValidationError('ไม่รู้จัก subcommand นี้');
    }
  }

  private async setupRoles(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    const settings = await this.requireSettings(guild.id);
    const actor = await guild.members.fetch(interaction.user.id);

    if (settings.devRoleId === null) {
      const canBootstrap = guild.ownerId === actor.id || actor.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!canBootstrap) {
        throw new AuthorizationError('การตั้งค่าครั้งแรกต้องใช้ Server Owner หรือ Discord Administrator');
      }
    } else {
      requireCapability(resolveMemberAuthority(actor, settings), 'SYSTEM_CONFIGURE');
    }

    const roleIds = {
      devRoleId: interaction.options.getRole('dev', true).id,
      headRoleId: interaction.options.getRole('head', true).id,
      deputyRoleId: interaction.options.getRole('deputy', true).id,
      activeMemberRoleId: interaction.options.getRole('member', true).id,
      formerMemberRoleId: interaction.options.getRole('former', true).id,
    };
    ensureDistinctRoleIds(roleIds);
    await this.dependencies.guildConfig.configureRoles(guild.id, roleIds);
    await interaction.reply({ ...buildNotice('success', 'บันทึก Role สำเร็จ', 'ระบบบันทึก Role ทั้ง 5 รายการเรียบร้อยแล้ว', 'System Setup'), flags: MessageFlags.Ephemeral });
  }

  private async setChannel(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'CHANNEL_CONFIGURE');
    const field = interaction.options.getString('type', true);
    if (!isConfigurableChannel(field)) {
      throw new ValidationError('ประเภท Channel ไม่ถูกต้อง');
    }
    const selectedChannel = interaction.options.getChannel('channel', true);
    let channel;
    try {
      channel = await guild.channels.fetch(selectedChannel.id);
    } catch (error: unknown) {
      if (error instanceof DiscordAPIError && error.code === DISCORD_MISSING_ACCESS_ERROR) {
        throw new ValidationError(
          'Bot มองไม่เห็น Channel นี้ กรุณาอนุญาต View Channel ให้ Role ของ Bot ก่อน',
        );
      }
      throw error;
    }
    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      throw new ValidationError('Channel นี้ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้');
    }
    const botMember = guild.members.me ?? await guild.members.fetchMe();
    const botPermissions = channel.permissionsFor(botMember);
    const missingPermissions = listMissingBotChannelPermissions(botPermissions);
    if (missingPermissions.length > 0) {
      throw new ValidationError(
        `Bot ยังใช้ Channel นี้ไม่ได้ กรุณาอนุญาต: ${missingPermissions.join(', ')}`,
      );
    }
    await this.dependencies.guildConfig.configureChannel(guild.id, field, channel.id);
    if (field === 'registrationRequestChannelId') {
      const queued = await this.dependencies.members.queuePendingRegistrationRequestSync(guild.id);
      await interaction.reply({ ...buildNotice(
        'success',
        'บันทึก Channel สำเร็จ',
        `คำขอลงทะเบียน: <#${channel.id}>\nกำลังส่งคำขอค้าง **${queued.toString()} รายการ**`,
        'Channel Setup',
      ), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ ...buildNotice('success', 'บันทึก Channel สำเร็จ', `ตั้งค่า **${field}** เป็น <#${channel.id}> แล้ว`, 'Channel Setup'), flags: MessageFlags.Ephemeral });
  }

  private async publishControlPanel(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    if (settings.controlChannelId === null) {
      throw new ValidationError('กรุณาตั้งค่า Control Channel ก่อน');
    }
    if (interaction.channelId !== settings.controlChannelId) {
      throw new ValidationError(`ต้องใช้คำสั่งนี้ใน <#${settings.controlChannelId}>`);
    }
    if (interaction.channel === null || !interaction.channel.isSendable()) {
      throw new ValidationError('Bot ไม่สามารถส่งข้อความใน Channel นี้');
    }

    if (settings.controlPanelMessageId !== null) {
      const existing = await interaction.channel.messages.fetch(settings.controlPanelMessageId).catch(() => null);
      if (existing !== null) {
        const replacement = await interaction.channel.send(buildControlPanel());
        try {
          await this.dependencies.guildConfig.saveControlPanelMessage(guild.id, replacement.id);
        } catch (error: unknown) {
          await replacement.delete().catch(() => undefined);
          throw error;
        }
        await existing.delete().catch(() => undefined);
        await interaction.reply({ ...buildNotice('success', 'รีเฟรช Control Panel แล้ว', 'ย้าย Control Panel ลงท้าย Channel เพื่อไม่ต้องเลื่อนหาข้อความเดิม', 'Management Control'), flags: MessageFlags.Ephemeral });
        return;
      }
    }
    const message = await interaction.channel.send(buildControlPanel());
    await this.dependencies.guildConfig.saveControlPanelMessage(guild.id, message.id);
    await interaction.reply({ ...buildNotice('success', 'สร้าง Control Panel แล้ว', 'ศูนย์ควบคุมสำหรับหัวแก๊ง/รองแก๊งพร้อมใช้งาน', 'Management Control'), flags: MessageFlags.Ephemeral });
  }

  private async publishRegistration(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(this.dependencies.client, settings.memberChannelId, 'Channel สมาชิก');
    await channel.send(buildRegistrationPanel());
    await interaction.reply({ ...buildNotice('success', 'ส่งแผงลงทะเบียนแล้ว', `ปลายทาง: <#${channel.id}>`, 'Member Registration'), flags: MessageFlags.Ephemeral });
  }

  private async publishMemberRoster(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const settings = await this.requireSettings(guild.id);
    const channel = await fetchSendableChannel(
      this.dependencies.client,
      settings.memberRosterChannelId,
      'Channel รายชื่อสมาชิกปัจจุบัน',
    );
    const roster = buildMemberRoster(await this.dependencies.members.listActive(guild.id));

    if (settings.memberRosterMessageId !== null) {
      const existing = await channel.messages.fetch(settings.memberRosterMessageId).catch(() => null);
      if (existing !== null) {
        await existing.edit(roster);
        await interaction.reply({ ...buildNotice('success', 'อัปเดตรายชื่อสมาชิกแล้ว', `ปลายทาง: <#${channel.id}>`, 'Member Roster'), flags: MessageFlags.Ephemeral });
        return;
      }
    }

    const message = await channel.send(roster);
    await this.dependencies.guildConfig.saveMemberRosterMessage(guild.id, message.id);
    await interaction.reply({ ...buildNotice('success', 'ส่งรายชื่อสมาชิกแล้ว', `ปลายทาง: <#${channel.id}>`, 'Member Roster'), flags: MessageFlags.Ephemeral });
  }

  private async addMember(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'MEMBER_MANAGE');
    const settings = await this.requireSettings(guild.id);
    const roleIds = requireMemberRoleIds(settings);
    const target = interaction.options.getUser('user', true);
    const inGameName = interaction.options.getString('name', true);
    const member = await this.dependencies.members.addDirectly(guild.id, target.id, inGameName, interaction.user.id, roleIds);
    await interaction.reply({ ...buildNotice('success', 'เพิ่มสมาชิกสำเร็จ', `<@${target.id}> • **${member.inGameName}**\nระบบกำลังซิงก์ Role อัตโนมัติ`, 'Member Management'), flags: MessageFlags.Ephemeral });
  }

  private async removeMember(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'MEMBER_MANAGE');
    const settings = await this.requireSettings(guild.id);
    const roleIds = requireMemberRoleIds(settings);
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    await this.dependencies.members.markFormer(guild.id, target.id, interaction.user.id, reason, roleIds);
    await interaction.reply({ ...buildNotice('success', 'อัปเดตสถานะสมาชิกแล้ว', `<@${target.id}> ถูกเปลี่ยนเป็นอดีตสมาชิก/พี่น้อง\nระบบกำลังซิงก์ Role อัตโนมัติ`, 'Member Management'), flags: MessageFlags.Ephemeral });
  }

  private async showHealth(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await this.requireAuthority(guild, interaction.user.id, 'ROUTINE_ADMIN');
    const databaseHealthy = await this.dependencies.checkDatabase();
    const websocketPing = this.dependencies.client.ws.ping;
    await interaction.reply({ ...buildNotice(
      databaseHealthy ? 'success' : 'danger',
      'สถานะระบบ MiruBot',
      `**Discord** • ${websocketPing.toString()} ms ✅\n**Database** • ${databaseHealthy ? 'พร้อมใช้งาน ✅' : 'ผิดปกติ ❌'}`,
      'Health Check',
    ), flags: MessageFlags.Ephemeral });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === componentIds.registerButton) {
      await this.showRegistrationModal(interaction, requireGuild(interaction.guild));
      return;
    }

    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith(memberRosterMemberPagePrefix)) {
      await this.requireAuthority(guild, interaction.user.id, 'ROSTER_TITLE_MANAGE');
      const context = parseRosterMemberContext(interaction.customId, memberRosterMemberPagePrefix);
      await interaction.update(buildRosterMemberSelector(
        context.title,
        await this.listRoleVerifiedActiveMembers(guild),
        context.page,
      ));
      return;
    }
    if (interaction.customId.startsWith(memberRosterPagePrefix)) {
      const page = parsePositivePage(interaction.customId.slice(memberRosterPagePrefix.length));
      await interaction.update(buildMemberRoster(await this.dependencies.members.listActive(guild.id), page));
      return;
    }
    if (interaction.customId === componentIds.controlMembers) {
      await this.requireAuthority(guild, interaction.user.id, 'ROSTER_TITLE_MANAGE');
      await interaction.reply({ ...buildRosterTitleSelector(), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId.startsWith('member:approve:')) {
      await this.requireAuthority(guild, interaction.user.id, 'MEMBER_MANAGE');
      const memberId = requireEntityId(interaction.customId, 'member:approve:');
      const settings = await this.requireSettings(guild.id);
      const member = await this.dependencies.members.approve(guild.id, memberId, interaction.user.id, requireMemberRoleIds(settings));
      await interaction.update(buildMemberRegistrationRequest(member));
      return;
    }

    if (interaction.customId.startsWith('member:reject:')) {
      await this.requireAuthority(guild, interaction.user.id, 'MEMBER_MANAGE');
      const memberId = requireEntityId(interaction.customId, 'member:reject:');
      await interaction.showModal(buildRejectModal(memberId));
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === memberRosterTitleSelectId) {
      await this.requireAuthority(guild, interaction.user.id, 'ROSTER_TITLE_MANAGE');
      const title = parseRosterTitleSelection(interaction.values[0]);
      await interaction.update(buildRosterMemberSelector(title, await this.listRoleVerifiedActiveMembers(guild)));
      return;
    }
    if (interaction.customId.startsWith(memberRosterMemberSelectPrefix)) {
      await this.requireAuthority(guild, interaction.user.id, 'ROSTER_TITLE_MANAGE');
      const context = parseRosterMemberContext(interaction.customId, memberRosterMemberSelectPrefix);
      const memberId = interaction.values[0];
      if (memberId === undefined) throw new ValidationError('กรุณาเลือกสมาชิก');
      const member = await this.dependencies.members.findById(guild.id, memberId);
      if (member === null || member.status !== 'ACTIVE') {
        throw new ValidationError('สมาชิกนี้ไม่มีสถานะใช้งานแล้ว กรุณาเลือกรายชื่อใหม่');
      }
      const settings = await this.requireSettings(guild.id);
      const verified = await filterRoleVerifiedActiveMembers(guild, settings, [member]);
      if (verified.length === 0) {
        throw new ValidationError('สมาชิกนี้ยังไม่ได้รับยศใน Discord กรุณาเลือกรายชื่อใหม่');
      }
      const updated = await this.dependencies.members.assignRosterTitle(
        guild.id,
        member.id,
        context.title === 'NONE' ? null : context.title,
        interaction.user.id,
        requireMemberRoleIds(settings),
      );
      const display = rosterTitleDisplay(updated.rosterTitle);
      const next = buildRosterTitleSelector();
      await interaction.update({
        ...buildNotice('success', 'บันทึกตำแหน่งสมาชิกแล้ว', `${display.emoji} **${updated.inGameName}** → **${display.label}**\nระบบกำลังซิงก์ Role อัตโนมัติ`, 'Member Roles'),
        components: next.components,
      });
      return;
    }
    if (interaction.customId !== componentIds.pendingMemberSelect) return;
    await this.requireAuthority(guild, interaction.user.id, 'MEMBER_MANAGE');
    const memberId = interaction.values[0];
    if (memberId === undefined) {
      throw new ValidationError('กรุณาเลือกสมาชิก');
    }
    const member = await this.dependencies.members.findById(guild.id, memberId);
    if (member === null || member.status !== 'PENDING') {
      throw new ValidationError('คำขอนี้ไม่มีอยู่หรือถูกดำเนินการแล้ว');
    }
    await interaction.update({ ...buildMemberDecision(member), content: null });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId === componentIds.registerModal) {
      const inGameName = interaction.fields.getTextInputValue(componentIds.registerNameInput);
      const member = await this.dependencies.members.register(guild.id, interaction.user.id, inGameName);
      await interaction.reply({ ...buildNotice('success', 'ส่งคำขอลงทะเบียนแล้ว', `ชื่อในเมือง: **${member.inGameName}**\nสถานะ: ⏳ รอหัวแก๊ง/รองแก๊งตรวจสอบ`, 'Member Registration'), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId.startsWith('member:reject_modal:')) {
      await this.requireAuthority(guild, interaction.user.id, 'MEMBER_MANAGE');
      const memberId = requireEntityId(interaction.customId, 'member:reject_modal:');
      const reason = interaction.fields.getTextInputValue(componentIds.rejectReasonInput);
      const member = await this.dependencies.members.reject(guild.id, memberId, interaction.user.id, reason);
      await interaction.reply({ ...buildNotice('success', 'ปฏิเสธคำขอแล้ว', `คำขอของ <@${member.discordUserId}> ถูกปิดเรียบร้อย`, 'Member Registration'), flags: MessageFlags.Ephemeral });
    }
  }

  private async showRegistrationModal(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    guild: Guild,
  ): Promise<void> {
    const settings = await this.requireSettings(guild.id);
    await fetchSendableChannel(
      this.dependencies.client,
      settings.registrationRequestChannelId,
      'Channel คำขอลงทะเบียน',
    );
    const eligibility = await this.dependencies.members.getRegistrationEligibility(guild.id, interaction.user.id);
    if (eligibility === 'PENDING') {
      await interaction.reply({ ...buildNotice('warning', 'คำขอกำลังรอตรวจสอบ', 'คุณส่งคำขอลงทะเบียนแล้ว กรุณารอหัวแก๊ง/รองแก๊งดำเนินการ', 'Member Registration'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (eligibility === 'ACTIVE') {
      await interaction.reply({ ...buildNotice('info', 'ลงทะเบียนแล้ว', 'คุณเป็นสมาชิกที่มีสถานะใช้งานอยู่ จึงไม่ต้องลงทะเบียนซ้ำ', 'Member Registration'), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(buildRegistrationModal());
  }

  private async requireAuthority(guild: Guild, discordUserId: string, capability: Capability): Promise<AuthorityLevel> {
    const [settings, member] = await Promise.all([
      this.requireSettings(guild.id),
      guild.members.fetch(discordUserId),
    ]);
    const authority = resolveMemberAuthority(member, settings);
    requireCapability(authority, capability);
    return authority;
  }

  private async requireSettings(guildId: string): Promise<GuildSettings> {
    const settings = await this.dependencies.guildConfig.get(guildId);
    if (settings === null) {
      throw new ValidationError('ยังไม่ได้สร้างการตั้งค่าของ Server นี้');
    }
    return settings;
  }

  private async listRoleVerifiedActiveMembers(guild: Guild) {
    const [settings, members] = await Promise.all([
      this.requireSettings(guild.id),
      this.dependencies.members.listActive(guild.id),
    ]);
    return filterRoleVerifiedActiveMembers(guild, settings, members);
  }

  private async handleError(interaction: Interaction, error: unknown): Promise<void> {
    const publicMessage = error instanceof DomainError ? error.message : 'ระบบขัดข้อง กรุณาลองใหม่หรือติดต่อ Dev';
    const notice = buildNotice(
      error instanceof DomainError ? 'warning' : 'danger',
      error instanceof DomainError ? 'ไม่สามารถดำเนินการได้' : 'ระบบเกิดข้อผิดพลาด',
      publicMessage,
      'System Response',
    );
    if (!(error instanceof DomainError)) {
      this.dependencies.logger.error({ err: error, interactionId: interaction.id }, 'interaction failed');
    }

    if (!interaction.isRepliable()) {
      return;
    }
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ...notice, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ ...notice, flags: MessageFlags.Ephemeral });
  }
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) {
    throw new ValidationError('คำสั่งนี้ใช้ได้เฉพาะใน Discord Server');
  }
  return guild;
}

function resolveMemberAuthority(member: GuildMember, settings: GuildSettings): AuthorityLevel {
  const authority = resolveAuthority(new Set(member.roles.cache.keys()), {
    devRoleId: settings.devRoleId,
    headRoleId: settings.headRoleId,
    deputyRoleId: settings.deputyRoleId,
    activeMemberRoleId: settings.activeMemberRoleId,
  });
  if (authority === null) {
    throw new AuthorizationError();
  }
  return authority;
}

function requireMemberRoleIds(settings: GuildSettings): MemberRoleIds {
  if (
    settings.headRoleId === null
    || settings.deputyRoleId === null
    || settings.activeMemberRoleId === null
    || settings.formerMemberRoleId === null
  ) {
    throw new ValidationError('กรุณาตั้งค่า Role หัวแก๊ง รองแก๊ง สมาชิก และอดีตสมาชิกก่อน');
  }
  return {
    headRoleId: settings.headRoleId,
    deputyRoleId: settings.deputyRoleId,
    activeMemberRoleId: settings.activeMemberRoleId,
    formerMemberRoleId: settings.formerMemberRoleId,
  };
}

function ensureDistinctRoleIds(roles: Record<string, string>): void {
  const ids = Object.values(roles);
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('Role ทั้ง 5 ประเภทต้องไม่ซ้ำกัน');
  }
}

function isConfigurableChannel(value: string): value is ConfigurableChannel {
  return channelFields.includes(value as ConfigurableChannel);
}

function requireEntityId(customId: string, prefix: string): string {
  const entityId = customId.slice(prefix.length);
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return entityId;
}

function parsePositivePage(value: string): number {
  const page = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(page) || page < 1) {
    throw new ValidationError('หน้ารายชื่อสมาชิกไม่ถูกต้อง');
  }
  return page;
}

function parseRosterTitleSelection(value: string | undefined): RosterTitleSelection {
  if (value === 'HEAD' || value === 'DEPUTY' || value === 'ACCOUNTANT' || value === 'RESERVE' || value === 'NONE') return value;
  throw new ValidationError('ตำแหน่งกำกับสมาชิกไม่ถูกต้อง');
}

function parseRosterMemberContext(
  customId: string,
  prefix: string,
): { readonly title: RosterTitleSelection; readonly page: number } {
  const [rawTitle, rawPage, ...extra] = customId.slice(prefix.length).split(':');
  if (extra.length > 0) throw new ValidationError('ข้อมูลเลือกสมาชิกไม่ถูกต้อง');
  return { title: parseRosterTitleSelection(rawTitle), page: parsePositivePage(rawPage ?? '') };
}

async function fetchSendableChannel(client: Client, channelId: string | null, label: string): Promise<SendableChannels> {
  if (channelId === null) {
    throw new ValidationError(`กรุณาตั้งค่า ${label} ก่อน`);
  }
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
    throw new ValidationError(`${label} ไม่ใช่ Text Channel ที่ Bot ส่งข้อความได้`);
  }
  return channel;
}
