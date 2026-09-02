import {
  EmbedBuilder,
  type APIEmbedField,
  type EmbedFooterData,
  type RestOrArray,
} from 'discord.js';

const miruBrand = 'ᴍɪʀᴜ sʏsᴛᴇᴍ';
const copyright = '© xᴄʀᴜɪᴢᴛ';
const titlePrefix = '╭─・✦ ';
const titleSuffix = ' ✦';
const footerPrefix = '╰─・';
const footerSuffix = '・✦';

export const miruColors = {
  primary: 0x00a884,
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x2b2d31,
} as const;

export type MiruTone = keyof typeof miruColors;

export class MiruEmbedBuilder extends EmbedBuilder {
  public constructor() {
    super();
    this.setColor(miruColors.primary);
    this.setFooter({ text: miruBrand });
    this.setTimestamp();
  }

  public override setTitle(title: string): this {
    const normalizedTitle = stripTitleDecoration(title);
    super.setTitle(limitText(`${titlePrefix}${normalizedTitle}${titleSuffix}`, 256));
    return this;
  }

  public override setDescription(description: string | null): this {
    super.setDescription(description === null ? null : decorateBlock(description, 4_096));
    return this;
  }

  public override addFields(...fields: RestOrArray<APIEmbedField>): this {
    const normalizedFields = fields.flatMap((field) => Array.isArray(field) ? field : [field]);
    super.addFields(...normalizedFields.map(decorateField));
    return this;
  }

  public override setFooter(options: EmbedFooterData | null): this {
    if (options === null) {
      super.setFooter({ text: decorateFooter(copyright) });
      return this;
    }
    super.setFooter({ ...options, text: decorateFooter(withCopyright(options.text)) });
    return this;
  }
}

const toneIcons: Readonly<Record<MiruTone, string>> = {
  primary: '✦',
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  danger: '❌',
  neutral: '◆',
};

export interface MiruEmbedOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: MiruTone;
  readonly icon?: string;
  readonly module?: string;
  readonly fields?: readonly APIEmbedField[];
  readonly timestamp?: boolean;
}

export function buildMiruEmbed(options: MiruEmbedOptions): MiruEmbedBuilder {
  const tone = options.tone ?? 'primary';
  const embed = new MiruEmbedBuilder()
    .setColor(miruColors[tone])
    .setTitle(`${options.icon ?? toneIcons[tone]} ${options.title}`)
    .setFooter({ text: `${miruBrand}${options.module === undefined ? '' : ` • ${options.module}`}` });
  if (options.description !== undefined && options.description.length > 0) {
    embed.setDescription(options.description);
  }
  if (options.fields !== undefined && options.fields.length > 0) {
    embed.addFields(...options.fields);
  }
  if (options.timestamp ?? true) embed.setTimestamp();
  return embed;
}

export function buildNotice(
  tone: MiruTone,
  title: string,
  description: string,
  module = 'Notification',
) {
  return {
    embeds: [buildMiruEmbed({ tone, title, description, module })],
    allowedMentions: { parse: [] as const },
  };
}

export function formatPanelText(
  icon: string,
  title: string,
  description: string,
  hint?: string,
): string {
  const lines = [
    `### ${titlePrefix}${icon} ${title}${titleSuffix}`,
    decorateBlock(description, 3_200),
    '',
  ];
  if (hint !== undefined) lines.push(`-# ├・✧ ${hint}`);
  lines.push(`-# ${decorateFooter(`${miruBrand} • ${copyright}`)}`);
  return lines.join('\n');
}

export function formatOverview(lines: readonly string[]): string {
  return ['**╭─・⌗ ภาพรวม**', ...lines.map((line, index) => (
    `${index === lines.length - 1 ? '╰' : '├'}・${line}`
  ))].join('\n');
}

function withCopyright(text: string): string {
  return text.includes(copyright) ? text : `${text} • ${copyright}`;
}

function stripTitleDecoration(title: string): string {
  return title
    .replace(/^╭(?:─)?・(?:✦\s*)?/, '')
    .replace(/\s*✦$/, '')
    .trim();
}

function decorateBlock(value: string, maximumLength: number): string {
  const normalized = value.startsWith('> ')
    ? value
    : `> ${value.replaceAll('\n', '\n> ')}`;
  return limitText(normalized, maximumLength);
}

function decorateField(field: APIEmbedField): APIEmbedField {
  if (field.name === '\u200b' || field.value === '\u200b') return field;
  const name = field.name.startsWith('⌗・') ? field.name : `⌗・${field.name}`;
  return {
    ...field,
    name: limitText(name, 256),
    value: decorateBlock(field.value, 1_024),
  };
}

function decorateFooter(text: string): string {
  const normalized = text
    .replace(/^╰─・/, '')
    .replace(/・✦$/, '')
    .trim();
  return limitText(`${footerPrefix}${normalized}${footerSuffix}`, 2_048);
}

function limitText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 1)}…`;
}
