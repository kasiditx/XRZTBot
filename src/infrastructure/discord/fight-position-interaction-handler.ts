import {
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';
import type { FightPositionService } from '../../modules/fight-positions/service.js';
import type { GuildConfigService } from '../../modules/guild-config/service.js';
import type { MemberService } from '../../modules/members/service.js';
import { hasCapability, resolveAuthority } from '../../modules/authorization/permissions.js';
import type { GuildSettings } from '../db/schema.js';
import type { FightPositionSet } from '../db/schema.js';
import { componentIds } from './components.js';
import {
  buildFightPositionAdminPanel,
  buildFightPositionAssignedMemberSelector,
  buildFightPositionAssignmentSelector,
  buildFightPositionDeleteConfirmation,
  buildFightPositionManagement,
  buildFightPositionMemberSelector,
  buildFightPositionNameModal,
  buildFightPositionSetNameModal,
  buildFightPositionSummary,
  fightPositionComponentIds,
} from './fight-position-components.js';
import { syncFightPositionSummary } from './fight-position-publisher.js';
import type { Client } from 'discord.js';
import { buildNotice } from './theme.js';
import { filterRoleVerifiedActiveMembers } from './role-verified-members.js';

export interface FightPositionInteractionDependencies {
  readonly client: Client;
  readonly fightPositions: FightPositionService;
  readonly guildConfig: GuildConfigService;
  readonly members: MemberService;
}

export class FightPositionInteractionHandler {
  public constructor(private readonly dependencies: FightPositionInteractionDependencies) {}

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && (
      interaction.customId === componentIds.controlFightPositions
      || interaction.customId.startsWith('fight:')
    )) {
      await this.handleButton(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('fight:')) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('fight:')) {
      await this.handleModal(interaction);
      return true;
    }
    return false;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    if (interaction.customId.startsWith(fightPositionComponentIds.summaryPagePrefix)) {
      const page = parsePage(interaction.customId.slice(fightPositionComponentIds.summaryPagePrefix.length));
      await interaction.update(buildFightPositionSummary(
        await this.dependencies.fightPositions.listAllSetRosters(guild.id),
        page,
      ));
      return;
    }

    await this.requireAdmin(guild, interaction.user.id);
    if (interaction.customId === componentIds.controlFightPositions) {
      const [sets, positions] = await Promise.all([
        this.dependencies.fightPositions.listSets(guild.id),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      const selectedSet = requireSelectedSet(sets);
      await interaction.reply({
        ...buildFightPositionAdminPanel(sets, selectedSet, positions),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === fightPositionComponentIds.addSet) {
      await interaction.showModal(buildFightPositionSetNameModal());
      return;
    }
    if (interaction.customId === fightPositionComponentIds.add) {
      await interaction.showModal(buildFightPositionNameModal());
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.activateSetPrefix)) {
      const activeSet = await this.dependencies.fightPositions.activateSet(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.activateSetPrefix),
        interaction.user.id,
      );
      const [sets, positions] = await Promise.all([
        this.dependencies.fightPositions.listSets(guild.id),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      await interaction.update(buildFightPositionAdminPanel(sets, activeSet, positions));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.assignSetPrefix)) {
      const set = await this.dependencies.fightPositions.getSet(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.assignSetPrefix),
      );
      const members = await this.filterRoleVerifiedMembers(
        guild,
        await this.dependencies.fightPositions.listUnassignedMembers(guild.id, set.id),
      );
      await interaction.reply({
        ...buildFightPositionMemberSelector(set, members),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.editAssignmentSetPrefix)) {
      const set = await this.dependencies.fightPositions.getSet(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.editAssignmentSetPrefix),
      );
      const members = await this.filterRoleVerifiedMembers(
        guild,
        await this.dependencies.fightPositions.listAssignedMembers(guild.id, set.id),
      );
      await interaction.reply({
        ...buildFightPositionAssignedMemberSelector(set, members),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === fightPositionComponentIds.publish) {
      const channel = await syncFightPositionSummary(
        this.dependencies.client,
        this.dependencies.fightPositions,
        this.dependencies.guildConfig,
        guild.id,
        true,
      );
      if (channel === null) throw new ValidationError('กรุณาตั้งค่า Channel ตำแหน่ง Fight ก่อน');
      await interaction.reply({ ...buildNotice('success', 'อัปเดตสรุปตำแหน่ง Fight แล้ว', `ปลายทาง: <#${channel.id}>`, 'Fight Positions'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.managePagePrefix)) {
      const context = parseSetPageContext(interaction.customId, fightPositionComponentIds.managePagePrefix);
      const [sets, selectedSet, positions] = await Promise.all([
        this.dependencies.fightPositions.listSets(guild.id),
        this.dependencies.fightPositions.getSet(guild.id, context.setId),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      await interaction.update(buildFightPositionAdminPanel(sets, selectedSet, positions, context.page));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.assignMemberPagePrefix)) {
      const context = parseSetPageContext(interaction.customId, fightPositionComponentIds.assignMemberPagePrefix);
      const set = await this.dependencies.fightPositions.getSet(guild.id, context.setId);
      const members = await this.filterRoleVerifiedMembers(
        guild,
        await this.dependencies.fightPositions.listUnassignedMembers(guild.id, set.id),
      );
      await interaction.update(buildFightPositionMemberSelector(
        set,
        members,
        context.page,
      ));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.editMemberPagePrefix)) {
      const context = parseSetPageContext(interaction.customId, fightPositionComponentIds.editMemberPagePrefix);
      const set = await this.dependencies.fightPositions.getSet(guild.id, context.setId);
      const members = await this.filterRoleVerifiedMembers(
        guild,
        await this.dependencies.fightPositions.listAssignedMembers(guild.id, set.id),
      );
      await interaction.update(buildFightPositionAssignedMemberSelector(
        set,
        members,
        context.page,
      ));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.assignPositionPagePrefix)) {
      const context = parseSetMemberPageContext(
        interaction.customId,
        fightPositionComponentIds.assignPositionPagePrefix,
      );
      const [set, member, positions] = await Promise.all([
        this.dependencies.fightPositions.getSet(guild.id, context.setId),
        this.requireRoleVerifiedActiveMember(guild, context.memberId),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      await interaction.update(buildFightPositionAssignmentSelector(
        set,
        member,
        positions,
        context.page,
      ));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.renamePrefix)) {
      const position = await this.dependencies.fightPositions.getActive(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.renamePrefix),
      );
      await interaction.showModal(buildFightPositionNameModal(position));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.deleteConfirmPrefix)) {
      const position = await this.dependencies.fightPositions.remove(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.deleteConfirmPrefix),
        interaction.user.id,
      );
      await interaction.update({ ...buildNotice('success', 'ลบตำแหน่งแล้ว', `ตำแหน่ง: **${position.name}**\nสมาชิกเดิมถูกเปลี่ยนเป็น **ยังไม่กำหนดตำแหน่ง**`, 'Fight Positions'), components: [] });
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.deletePrefix)) {
      const position = await this.dependencies.fightPositions.getActive(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.deletePrefix),
      );
      await interaction.update(buildFightPositionDeleteConfirmation(position));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.clearPrefix)) {
      const context = parseSetMemberContext(interaction.customId, fightPositionComponentIds.clearPrefix);
      const result = await this.dependencies.fightPositions.assign(
        guild.id,
        context.setId,
        context.memberId,
        null,
        interaction.user.id,
      );
      await interaction.update({ ...buildNotice('success', 'ถอดตำแหน่งแล้ว', `Fight Set: **${result.set.name}**\nสมาชิก: **${result.member.inGameName}**\nสถานะ: **ยังไม่กำหนดตำแหน่ง**`, 'Fight Positions'), components: [] });
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    await this.requireAdmin(guild, interaction.user.id);
    const selectedId = interaction.values[0];
    if (selectedId === undefined) throw new ValidationError('กรุณาเลือกรายการ');

    if (interaction.customId === fightPositionComponentIds.setSelect) {
      const [sets, selectedSet, positions] = await Promise.all([
        this.dependencies.fightPositions.listSets(guild.id),
        this.dependencies.fightPositions.getSet(guild.id, requireUuid(selectedId)),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      await interaction.update(buildFightPositionAdminPanel(sets, selectedSet, positions));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.manageSelectPrefix)) {
      await interaction.update(buildFightPositionManagement(
        await this.dependencies.fightPositions.getActive(guild.id, requireUuid(selectedId)),
      ));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.assignMemberPrefix)) {
      const context = parseSetPageContext(interaction.customId, fightPositionComponentIds.assignMemberPrefix);
      const [set, member, positions] = await Promise.all([
        this.dependencies.fightPositions.getSet(guild.id, context.setId),
        this.requireRoleVerifiedActiveMember(guild, requireUuid(selectedId)),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      await interaction.update(buildFightPositionAssignmentSelector(
        set,
        member,
        positions,
      ));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.editMemberPrefix)) {
      const context = parseSetPageContext(interaction.customId, fightPositionComponentIds.editMemberPrefix);
      const [set, member, positions] = await Promise.all([
        this.dependencies.fightPositions.getSet(guild.id, context.setId),
        this.requireRoleVerifiedActiveMember(guild, requireUuid(selectedId)),
        this.dependencies.fightPositions.listActive(guild.id),
      ]);
      await interaction.update(buildFightPositionAssignmentSelector(
        set,
        member,
        positions,
      ));
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.assignPositionPrefix)) {
      const context = parseSetMemberPageContext(
        interaction.customId,
        fightPositionComponentIds.assignPositionPrefix,
      );
      await this.requireRoleVerifiedActiveMember(guild, context.memberId);
      const result = await this.dependencies.fightPositions.assign(
        guild.id,
        context.setId,
        context.memberId,
        requireUuid(selectedId),
        interaction.user.id,
      );
      await interaction.update({
        ...buildNotice(
          'success',
          'มอบตำแหน่งสำเร็จ',
          `Fight Set: **${result.set.name}**\n**${result.member.inGameName}** → ${result.position?.emoji ?? '➖'} **${result.position?.name ?? 'ยังไม่กำหนดตำแหน่ง'}**`,
          'Fight Positions',
        ),
        components: [],
      });
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guild = requireGuild(interaction.guild);
    await this.requireAdmin(guild, interaction.user.id);
    if (interaction.customId === fightPositionComponentIds.addSetModal) {
      const setName = interaction.fields.getTextInputValue(fightPositionComponentIds.setNameInput);
      const set = await this.dependencies.fightPositions.createSet(guild.id, setName, interaction.user.id);
      await interaction.reply({ ...buildNotice('success', 'เพิ่ม Fight Set แล้ว', `📋 **${set.name}** พร้อมจัดตำแหน่ง\nกด **ใช้ Set นี้** เมื่อต้องการเปลี่ยนแผนที่ใช้งาน`, 'Fight Positions'), flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.fields.getTextInputValue(fightPositionComponentIds.nameInput);
    const emoji = interaction.fields.getTextInputValue(fightPositionComponentIds.emojiInput);
    if (interaction.customId === fightPositionComponentIds.addModal) {
      const position = await this.dependencies.fightPositions.create(guild.id, name, emoji, interaction.user.id);
      await interaction.reply({ ...buildNotice('success', 'เพิ่มตำแหน่งแล้ว', `${position.emoji} **${position.name}** พร้อมใช้งาน`, 'Fight Positions'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith(fightPositionComponentIds.renameModalPrefix)) {
      const position = await this.dependencies.fightPositions.rename(
        guild.id,
        entityId(interaction.customId, fightPositionComponentIds.renameModalPrefix),
        name,
        emoji,
        interaction.user.id,
      );
      await interaction.reply({ ...buildNotice('success', 'แก้ไขตำแหน่งแล้ว', `ตำแหน่ง: ${position.emoji} **${position.name}**`, 'Fight Positions'), flags: MessageFlags.Ephemeral });
    }
  }

  private async requireAdmin(guild: Guild, discordUserId: string): Promise<void> {
    const settings = await this.requireSettings(guild.id);
    const member = await guild.members.fetch(discordUserId);
    const authority = resolveAuthority(new Set(member.roles.cache.keys()), {
      devRoleId: settings.devRoleId,
      headRoleId: settings.headRoleId,
      deputyRoleId: settings.deputyRoleId,
      activeMemberRoleId: settings.activeMemberRoleId,
    });
    if (authority === null || !hasCapability(authority, 'ROUTINE_ADMIN')) throw new AuthorizationError();
  }

  private async filterRoleVerifiedMembers<T extends { readonly discordUserId: string; readonly inGameName: string }>(
    guild: Guild,
    members: readonly T[],
  ): Promise<T[]> {
    const settings = await this.requireSettings(guild.id);
    return filterRoleVerifiedActiveMembers(guild, settings, members);
  }

  private async requireRoleVerifiedActiveMember(guild: Guild, memberId: string) {
    const member = await this.dependencies.members.findById(guild.id, memberId);
    if (member === null || member.status !== 'ACTIVE') {
      throw new ValidationError('สมาชิกนี้ไม่มีสถานะใช้งานแล้ว กรุณาเลือกรายชื่อใหม่');
    }
    const verified = await this.filterRoleVerifiedMembers(guild, [member]);
    if (verified.length === 0) {
      throw new ValidationError('สมาชิกนี้ยังไม่ได้รับยศใน Discord กรุณาเลือกรายชื่อใหม่');
    }
    return member;
  }

  private async requireSettings(guildId: string): Promise<GuildSettings> {
    const settings = await this.dependencies.guildConfig.get(guildId);
    if (settings === null) throw new ValidationError('ยังไม่ได้สร้างการตั้งค่าของ Server นี้');
    return settings;
  }
}

function requireGuild(guild: Guild | null): Guild {
  if (guild === null) throw new ValidationError('รายการนี้ใช้ได้เฉพาะใน Discord Server');
  return guild;
}

function entityId(customId: string, prefix: string): string {
  return requireUuid(customId.slice(prefix.length));
}

function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ValidationError('รหัสรายการไม่ถูกต้อง');
  }
  return value;
}

function parsePage(value: string): number {
  const page = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(page) || page < 1) {
    throw new ValidationError('หน้ารายการไม่ถูกต้อง');
  }
  return page;
}

function parseSetPageContext(customId: string, prefix: string) {
  const [rawSetId, rawPage, ...extra] = customId.slice(prefix.length).split(':');
  if (rawSetId === undefined || rawPage === undefined || extra.length > 0) {
    throw new ValidationError('ข้อมูล Fight Set ไม่ถูกต้อง');
  }
  return { setId: requireUuid(rawSetId), page: parsePage(rawPage) };
}

function parseSetMemberPageContext(customId: string, prefix: string) {
  const [rawSetId, rawMemberId, rawPage, ...extra] = customId.slice(prefix.length).split(':');
  if (rawSetId === undefined || rawMemberId === undefined || rawPage === undefined || extra.length > 0) {
    throw new ValidationError('ข้อมูลเลือกตำแหน่งไม่ถูกต้อง');
  }
  return { setId: requireUuid(rawSetId), memberId: requireUuid(rawMemberId), page: parsePage(rawPage) };
}

function parseSetMemberContext(customId: string, prefix: string) {
  const [rawSetId, rawMemberId, ...extra] = customId.slice(prefix.length).split(':');
  if (rawSetId === undefined || rawMemberId === undefined || extra.length > 0) {
    throw new ValidationError('ข้อมูลเลือกตำแหน่งไม่ถูกต้อง');
  }
  return { setId: requireUuid(rawSetId), memberId: requireUuid(rawMemberId) };
}

function requireSelectedSet(sets: readonly FightPositionSet[]): FightPositionSet {
  const set = sets.find((candidate) => candidate.isActive) ?? sets[0];
  if (set === undefined) throw new ValidationError('ไม่พบ Fight Set');
  return set;
}
