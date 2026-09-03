import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  FileUploadBuilder,
  LabelBuilder,
  type ModalSubmitFields,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { ValidationError } from '../../domain/errors.js';

export type EvidenceInputMode = 'FILE' | 'LINK';

export interface EvidenceAttachment {
  readonly id: string;
  readonly url: string;
  readonly contentType: string | null;
  readonly size: number;
}

export interface ResolvedEvidenceImage {
  readonly attachment: Buffer;
  readonly contentType: string | null;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

interface EvidenceInputLabelOptions {
  readonly mode: EvidenceInputMode;
  readonly fileCustomId: string;
  readonly linkCustomId: string;
  readonly maximumImages: number;
  readonly label: string;
}

interface ResolveEvidenceImagesInput {
  readonly mode: EvidenceInputMode;
  readonly uploadedFiles: readonly EvidenceAttachment[];
  readonly mediaLinkText: string;
  readonly maximumImages: number;
  readonly maximumBytesPerImage: number;
  readonly filenamePrefix: string;
}

export interface EvidenceModalContext {
  readonly mode: EvidenceInputMode;
  readonly context: string;
}

interface EvidenceSource {
  readonly url: URL;
  readonly contentTypeHint: string | null;
  readonly sizeHint: number | null;
}

const ALLOWED_DISCORD_MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const DISCORD_ATTACHMENT_PATH = /^\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/.+/u;
const DOWNLOAD_TIMEOUT_MS = 15_000;

export function buildEvidenceMethodPrompt(customId: string, title: string) {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('เลือกวิธีส่งรูปหลักฐาน')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      {
        label: 'แนบไฟล์รูป',
        value: 'FILE',
        emoji: '📎',
        description: 'เลือกไฟล์ที่บันทึกไว้ หรือวางภาพหาก Discord รองรับ',
      },
      {
        label: 'วาง Discord Media Link',
        value: 'LINK',
        emoji: '🔗',
        description: 'ใช้ Copy Media Link จากรูปที่ส่งไว้ใน Discord',
      },
    );
  return {
    content: `**${title}**\nเลือกส่งเป็นไฟล์รูป หรือวาง Discord Media Link`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)],
  };
}

export function buildEvidenceInputLabel(options: EvidenceInputLabelOptions): LabelBuilder {
  if (options.mode === 'FILE') {
    const file = new FileUploadBuilder()
      .setCustomId(options.fileCustomId)
      .setMinValues(1)
      .setMaxValues(options.maximumImages)
      .setRequired(true);
    return new LabelBuilder()
      .setLabel(`${options.label} ${imageCountLabel(options.maximumImages)}`)
      .setDescription('เลือกไฟล์ที่บันทึกไว้ หรือทดลองวางภาพด้วย Ctrl+V / Cmd+V')
      .setFileUploadComponent(file);
  }

  const mediaLink = new TextInputBuilder()
    .setCustomId(options.linkCustomId)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(4_000)
    .setRequired(true)
    .setPlaceholder(options.maximumImages === 1
      ? 'วาง Discord Media Link ที่ได้จาก Copy Media Link'
      : 'วาง Discord Media Link บรรทัดละ 1 ลิงก์');
  return new LabelBuilder()
    .setLabel(`Discord Media Link ${imageCountLabel(options.maximumImages)}`)
    .setDescription('รองรับเฉพาะลิงก์รูปจาก Discord และระบบจะเก็บรูปเข้า Log ทันที')
    .setTextInputComponent(mediaLink);
}

export function requireEvidenceInputMode(value: string | undefined): EvidenceInputMode {
  if (value !== 'FILE' && value !== 'LINK') {
    throw new ValidationError('วิธีส่งรูปหลักฐานไม่ถูกต้อง');
  }
  return value;
}

export function parseEvidenceModalContext(customId: string, prefix: string): EvidenceModalContext {
  const rawContext = customId.slice(prefix.length);
  const separatorIndex = rawContext.indexOf(':');
  if (separatorIndex < 0) {
    if (rawContext.length === 0) throw new ValidationError('ข้อมูลรูปหลักฐานไม่ถูกต้อง');
    return { mode: 'FILE', context: rawContext };
  }
  const mode = requireEvidenceInputMode(rawContext.slice(0, separatorIndex));
  const context = rawContext.slice(separatorIndex + 1);
  if (context.length === 0) throw new ValidationError('ข้อมูลรูปหลักฐานไม่ถูกต้อง');
  return { mode, context };
}

export function readEvidenceModalInput(
  fields: ModalSubmitFields,
  mode: EvidenceInputMode,
  fileCustomId: string,
  linkCustomId: string,
): Pick<ResolveEvidenceImagesInput, 'uploadedFiles' | 'mediaLinkText'> {
  if (mode === 'FILE') {
    return {
      uploadedFiles: [...fields.getUploadedFiles(fileCustomId, true).values()],
      mediaLinkText: '',
    };
  }
  return {
    uploadedFiles: [],
    mediaLinkText: fields.getTextInputValue(linkCustomId),
  };
}

export async function resolveEvidenceImages(
  input: ResolveEvidenceImagesInput,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedEvidenceImage[]> {
  const sources = buildEvidenceSources(input);
  return Promise.all(sources.map(async (source, index) => {
    if (source.sizeHint !== null && source.sizeHint > input.maximumBytesPerImage) {
      throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB ต่อรูป');
    }

    let response: Response;
    try {
      response = await fetcher(source.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new ValidationError('ดาวน์โหลดรูปหลักฐานจาก Discord ไม่สำเร็จ กรุณาลองใหม่');
    }
    if (!response.ok) {
      throw new ValidationError('Discord Media Link ใช้งานไม่ได้หรือหมดอายุ กรุณา Copy Media Link ใหม่');
    }

    const contentType = normalizeContentType(response.headers.get('content-type')) ?? normalizeContentType(source.contentTypeHint);
    const bytes = await readBoundedResponse(response, input.maximumBytesPerImage);
    return {
      attachment: bytes,
      contentType,
      name: `${input.filenamePrefix}-${String(index + 1)}.${fileExtension(contentType)}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    };
  }));
}

function buildEvidenceSources(input: ResolveEvidenceImagesInput): EvidenceSource[] {
  if (!Number.isSafeInteger(input.maximumImages) || input.maximumImages < 1 || input.maximumImages > 10) {
    throw new ValidationError('จำนวนรูปหลักฐานสูงสุดไม่ถูกต้อง');
  }
  if (!Number.isSafeInteger(input.maximumBytesPerImage) || input.maximumBytesPerImage < 1) {
    throw new ValidationError('ขนาดรูปหลักฐานสูงสุดไม่ถูกต้อง');
  }

  if (input.mode === 'FILE') {
    validateImageCount(input.uploadedFiles.length, input.maximumImages);
    return input.uploadedFiles.map((attachment) => ({
      url: requireDiscordMediaUrl(attachment.url),
      contentTypeHint: attachment.contentType,
      sizeHint: attachment.size,
    }));
  }

  const links = input.mediaLinkText
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  validateImageCount(links.length, input.maximumImages);
  return links.map((link) => ({
    url: requireDiscordMediaUrl(link),
    contentTypeHint: null,
    sizeHint: null,
  }));
}

function requireDiscordMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('Discord Media Link ไม่ถูกต้อง');
  }
  const isAllowed = url.protocol === 'https:'
    && url.username.length === 0
    && url.password.length === 0
    && url.port.length === 0
    && ALLOWED_DISCORD_MEDIA_HOSTS.has(url.hostname)
    && DISCORD_ATTACHMENT_PATH.test(url.pathname);
  if (!isAllowed) {
    throw new ValidationError('รองรับเฉพาะ Media Link ของไฟล์แนบจาก Discord');
  }
  return url;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > maximumBytes) {
    throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB ต่อรูป');
  }
  if (response.body === null) {
    throw new ValidationError('รูปหลักฐานว่างหรือไม่ถูกต้อง');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const rawChunk: unknown = result.value;
    if (!(rawChunk instanceof Uint8Array)) {
      throw new ValidationError('รูปหลักฐานว่างหรือไม่ถูกต้อง');
    }
    size += rawChunk.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new ValidationError('รูปหลักฐานต้องมีขนาดไม่เกิน 10 MB ต่อรูป');
    }
    chunks.push(rawChunk);
  }
  if (size < 1) throw new ValidationError('รูปหลักฐานว่างหรือไม่ถูกต้อง');
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

function normalizeContentType(value: string | null): string | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLocaleLowerCase('en');
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function fileExtension(contentType: string | null): string {
  const subtype = contentType?.slice('image/'.length).split(/[;+]/u)[0]?.toLocaleLowerCase('en') ?? '';
  const normalized = subtype === 'jpeg' ? 'jpg' : subtype;
  return /^[a-z0-9]{1,10}$/u.test(normalized) ? normalized : 'img';
}

function validateImageCount(count: number, maximumImages: number): void {
  if (count < 1 || count > maximumImages) {
    throw new ValidationError(maximumImages === 1 ? 'ต้องส่งรูปหลักฐาน 1 รูป' : `ต้องส่งรูปหลักฐาน 1–${String(maximumImages)} รูป`);
  }
}

function imageCountLabel(maximumImages: number): string {
  return maximumImages === 1 ? '1 รูป' : `1–${String(maximumImages)} รูป`;
}
