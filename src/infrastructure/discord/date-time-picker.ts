import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Interaction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { ValidationError } from '../../domain/errors.js';
import { formatPanelText } from './theme.js';

export type TemporalFieldType = 'DATE' | 'TIME' | 'DATETIME';

export interface TemporalFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: TemporalFieldType;
  readonly initialDate?: string;
}

export interface TemporalPickerStartInput {
  readonly flow: string;
  readonly continueCustomIdPrefix: string;
  readonly fields: readonly TemporalFieldDefinition[];
  readonly timezone: string;
  readonly context?: Readonly<Record<string, string>>;
}

export interface TemporalPickerResult {
  readonly values: Readonly<Record<string, string>>;
  readonly context: Readonly<Record<string, string>>;
  readonly timezone: string;
}

interface PickerSession {
  readonly id: string;
  readonly ownerDiscordUserId: string;
  readonly flow: string;
  readonly continueCustomIdPrefix: string;
  readonly fields: readonly TemporalFieldDefinition[];
  readonly timezone: string;
  readonly context: Readonly<Record<string, string>>;
  values: Record<string, string>;
  readonly expiresAt: number;
  fieldIndex: number;
  part: PickerPart;
  pageStart: string;
  draftDate: string | undefined;
  draftHour: string | undefined;
}

type PickerPart = 'DATE' | 'HOUR' | 'MINUTE' | 'COMPLETE';

const SESSION_TTL_MS = 15 * 60 * 1_000;
const DATE_PAGE_SIZE = 25;
const MINUTE_STEP = 5;
const pickerPrefix = 'datetime:';

export class DateTimePicker {
  private readonly sessions = new Map<string, PickerSession>();

  public async start(interaction: RepliableInteraction, input: TemporalPickerStartInput): Promise<void> {
    if (input.fields.length === 0) {
      throw new ValidationError('ต้องกำหนดช่องวันเวลาสำหรับตัวเลือกอย่างน้อย 1 ช่อง');
    }
    const now = DateTime.now().setZone(input.timezone).startOf('day');
    if (!now.isValid) {
      throw new ValidationError('Timezone ของ Server ไม่ถูกต้อง');
    }
    const firstField = input.fields[0]!;
    const pageStart = validIsoDate(firstField.initialDate) ?? now.toISODate();
    if (pageStart === null) {
      throw new ValidationError('ไม่สามารถเตรียมวันที่เริ่มต้นได้');
    }
    const session: PickerSession = {
      id: randomUUID(),
      ownerDiscordUserId: interaction.user.id,
      flow: input.flow,
      continueCustomIdPrefix: input.continueCustomIdPrefix,
      fields: input.fields,
      timezone: input.timezone,
      context: input.context ?? {},
      values: {},
      expiresAt: Date.now() + SESSION_TTL_MS,
      fieldIndex: 0,
      part: firstPart(firstField.type),
      pageStart,
      draftDate: undefined,
      draftHour: undefined,
    };
    this.sessions.set(session.id, session);
    const timer = setTimeout(() => this.sessions.delete(session.id), SESSION_TTL_MS);
    timer.unref();
    await interaction.reply({ ...buildPickerMessage(session), flags: MessageFlags.Ephemeral });
  }

  public async handle(interaction: Interaction): Promise<boolean> {
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(pickerPrefix)) {
      await this.handleSelect(interaction);
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith(pickerPrefix)) {
      await this.handleButton(interaction);
      return true;
    }
    return false;
  }

  public get(sessionId: string, ownerDiscordUserId: string, expectedFlow: string): TemporalPickerResult {
    const session = this.requireSession(sessionId, ownerDiscordUserId);
    if (session.flow !== expectedFlow || session.part !== 'COMPLETE') {
      throw new ValidationError('ขั้นตอนเลือกวันเวลายังไม่สมบูรณ์ กรุณาเริ่มรายการใหม่');
    }
    return { values: { ...session.values }, context: session.context, timezone: session.timezone };
  }

  public consume(sessionId: string, ownerDiscordUserId: string, expectedFlow: string): TemporalPickerResult {
    const result = this.get(sessionId, ownerDiscordUserId, expectedFlow);
    this.sessions.delete(sessionId);
    return result;
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const parsed = parsePickerCustomId(interaction.customId);
    const session = this.requireSession(parsed.sessionId, interaction.user.id);
    const value = interaction.values[0];
    if (value === undefined) {
      throw new ValidationError('กรุณาเลือกค่า');
    }
    const field = session.fields[session.fieldIndex];
    if (field === undefined) {
      throw new ValidationError('ไม่พบช่องวันเวลาที่กำลังเลือก');
    }

    if (parsed.action === 'date' && session.part === 'DATE') {
      if (validIsoDate(value) === null) throw new ValidationError('วันที่ที่เลือกไม่ถูกต้อง');
      session.draftDate = value;
      if (field.type === 'DATE') {
        finishField(session, value);
      } else {
        session.part = 'HOUR';
      }
    } else if (parsed.action === 'hour' && session.part === 'HOUR') {
      if (!/^(?:[01]\d|2[0-3])$/u.test(value)) throw new ValidationError('ชั่วโมงที่เลือกไม่ถูกต้อง');
      session.draftHour = value;
      session.part = 'MINUTE';
    } else if (parsed.action === 'minute' && session.part === 'MINUTE') {
      if (!/^(?:[0-5]\d)$/u.test(value) || Number(value) % MINUTE_STEP !== 0) {
        throw new ValidationError('นาทีที่เลือกไม่ถูกต้อง');
      }
      if (field.type === 'TIME' && session.draftHour !== undefined) {
        finishField(session, `${session.draftHour}:${value}`);
      } else if (field.type === 'DATETIME' && session.draftDate !== undefined && session.draftHour !== undefined) {
        finishField(session, `${session.draftDate}T${session.draftHour}:${value}`);
      } else {
        throw new ValidationError('ข้อมูลวันเวลาระหว่างขั้นตอนไม่ครบ');
      }
    } else {
      throw new ValidationError('ขั้นตอนเลือกวันเวลาไม่ตรงกับหน้าปัจจุบัน');
    }
    await interaction.update(buildPickerMessage(session));
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parsePickerCustomId(interaction.customId);
    const session = this.requireSession(parsed.sessionId, interaction.user.id);
    if (parsed.action === 'page') {
      if (session.part !== 'DATE') throw new ValidationError('ปุ่มเปลี่ยนหน้าวันที่ใช้ไม่ได้ในขั้นตอนนี้');
      const direction = parsed.argument;
      const current = DateTime.fromISO(session.pageStart, { zone: session.timezone });
      if (!current.isValid || (direction !== 'previous' && direction !== 'next' && direction !== 'today')) {
        throw new ValidationError('คำสั่งเปลี่ยนหน้าวันที่ไม่ถูกต้อง');
      }
      const next = direction === 'today'
        ? DateTime.now().setZone(session.timezone).startOf('day')
        : current.plus({ days: direction === 'next' ? DATE_PAGE_SIZE : -DATE_PAGE_SIZE });
      const pageStart = next.toISODate();
      if (pageStart === null) throw new ValidationError('ไม่สามารถเปลี่ยนหน้าวันที่ได้');
      session.pageStart = pageStart;
      await interaction.update(buildPickerMessage(session));
      return;
    }
    if (parsed.action === 'reset') {
      session.fieldIndex = 0;
      session.values = {};
      session.draftDate = undefined;
      session.draftHour = undefined;
      const firstField = session.fields[0]!;
      session.part = firstPart(firstField.type);
      session.pageStart = validIsoDate(firstField.initialDate)
        ?? DateTime.now().setZone(session.timezone).toISODate()
        ?? session.pageStart;
      await interaction.update(buildPickerMessage(session));
      return;
    }
    throw new ValidationError('ปุ่มตัวเลือกวันเวลาไม่ถูกต้อง');
  }

  private requireSession(sessionId: string, ownerDiscordUserId: string): PickerSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new ValidationError('หน้าต่างเลือกวันเวลาหมดอายุแล้ว กรุณาเริ่มรายการใหม่');
    }
    if (session.ownerDiscordUserId !== ownerDiscordUserId) {
      throw new ValidationError('ตัวเลือกนี้เป็นของผู้เริ่มรายการเท่านั้น');
    }
    return session;
  }
}

export function pickerSessionId(customId: string, prefix: string): string {
  const sessionId = customId.slice(prefix.length);
  if (!/^[0-9a-f-]{36}$/u.test(sessionId)) {
    throw new ValidationError('รหัสหน้าต่างเลือกวันเวลาไม่ถูกต้อง');
  }
  return sessionId;
}

export function pickerDateTimeToDate(value: string, timezone: string, label: string): Date {
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value) || !parsed.isValid) {
    throw new ValidationError(`${label}ไม่ถูกต้อง`);
  }
  return parsed.toJSDate();
}

function buildPickerMessage(session: PickerSession) {
  if (session.part === 'COMPLETE') {
    const summary = session.fields.map((field) => `• **${field.label}:** ${formatTemporalValue(session.values[field.key]!, field.type, session.timezone)}`).join('\n');
    return {
      content: formatPanelText('✅', 'ตรวจสอบวันเวลา', `${summary}\n\nTimezone: **${session.timezone}**`, 'ตรวจสอบข้อมูลก่อนดำเนินการต่อ'),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${session.continueCustomIdPrefix}${session.id}`)
          .setLabel('ดำเนินการต่อ')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${pickerPrefix}reset:${session.id}`)
          .setLabel('เลือกใหม่')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
      )],
    };
  }

  const field = session.fields[session.fieldIndex]!;
  const progress = `${String(session.fieldIndex + 1)}/${String(session.fields.length)}`;
  if (session.part === 'DATE') {
    const pageStart = DateTime.fromISO(session.pageStart, { zone: session.timezone });
    const options = Array.from({ length: DATE_PAGE_SIZE }, (_, index) => {
      const date = pageStart.plus({ days: index });
      const isoDate = date.toISODate()!;
      return { label: formatThaiDate(date), value: isoDate, description: isoDate };
    });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${pickerPrefix}date:${session.id}`)
      .setPlaceholder(`เลือก ${field.label}`.slice(0, 150))
      .addOptions(options);
    return {
      content: formatPanelText('📅', `เลือก${field.label}`, `ขั้นตอน **${progress}**`, 'เลือกจากรายการด้านล่าง'),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${pickerPrefix}page:${session.id}:previous`).setLabel('ก่อนหน้า 25 วัน').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${pickerPrefix}page:${session.id}:today`).setLabel('วันนี้').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${pickerPrefix}page:${session.id}:next`).setLabel('ถัดไป 25 วัน').setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }
  if (session.part === 'HOUR') {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${pickerPrefix}hour:${session.id}`)
      .setPlaceholder(`เลือกชั่วโมงของ ${field.label}`.slice(0, 150))
      .addOptions(Array.from({ length: 24 }, (_, hour) => {
        const value = String(hour).padStart(2, '0');
        return { label: `${value}:00 น.`, value };
      }));
    return {
      content: formatPanelText('🕐', `เลือกชั่วโมง — ${field.label}`, `ขั้นตอน **${progress}**${session.draftDate === undefined ? '' : `\nวันที่: **${formatTemporalValue(session.draftDate, 'DATE', session.timezone)}**`}`, 'เลือกเวลาได้ในรายการเดียว'),
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${pickerPrefix}minute:${session.id}`)
    .setPlaceholder(`เลือกนาทีของ ${field.label}`.slice(0, 150))
    .addOptions(Array.from({ length: 60 / MINUTE_STEP }, (_, index) => {
      const value = String(index * MINUTE_STEP).padStart(2, '0');
      return { label: `${session.draftHour ?? '00'}:${value} น.`, value };
    }));
  return {
    content: formatPanelText('🕐', `เลือกนาที — ${field.label}`, `ขั้นตอน **${progress}**`, `เลือกได้ทุก ${String(MINUTE_STEP)} นาที`),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

function finishField(session: PickerSession, value: string): void {
  const field = session.fields[session.fieldIndex]!;
  session.values[field.key] = value;
  session.fieldIndex += 1;
  session.draftDate = undefined;
  session.draftHour = undefined;
  const nextField = session.fields[session.fieldIndex];
  if (nextField === undefined) {
    session.part = 'COMPLETE';
    return;
  }
  session.part = firstPart(nextField.type);
  const selectedDate = field.type === 'TIME' ? null : value.slice(0, 10);
  session.pageStart = validIsoDate(nextField.initialDate)
    ?? validIsoDate(selectedDate ?? undefined)
    ?? DateTime.now().setZone(session.timezone).toISODate()
    ?? session.pageStart;
}

function firstPart(type: TemporalFieldType): PickerPart {
  return type === 'TIME' ? 'HOUR' : 'DATE';
}

function parsePickerCustomId(customId: string): { action: string; sessionId: string; argument?: string } {
  const [namespace, action, sessionId, argument] = customId.split(':');
  if (namespace !== 'datetime' || action === undefined || sessionId === undefined) {
    throw new ValidationError('รหัสตัวเลือกวันเวลาไม่ถูกต้อง');
  }
  return argument === undefined ? { action, sessionId } : { action, sessionId, argument };
}

function validIsoDate(value: string | undefined): string | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  return DateTime.fromISO(value, { zone: 'utc' }).isValid ? value : null;
}

function formatTemporalValue(value: string, type: TemporalFieldType, timezone: string): string {
  if (type === 'TIME') return `${value} น.`;
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) return value;
  const date = formatThaiDate(parsed);
  return type === 'DATE' ? date : `${date} เวลา ${parsed.toFormat('HH:mm')} น.`;
}

function formatThaiDate(value: DateTime): string {
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const weekdays = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
  return `${weekdays[value.weekday - 1]} ${String(value.day)} ${months[value.month - 1]} ${String(value.year + 543)}`;
}
