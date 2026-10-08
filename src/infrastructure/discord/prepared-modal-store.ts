import { randomUUID } from 'node:crypto';
import type { APIModalInteractionResponseCallbackData } from 'discord.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';

export const preparedModalPrefix = 'response:modal:';
const MODAL_TTL_MS = 2 * 60_000;
const MAX_PREPARED_MODALS = 500;

interface PreparedModal {
  readonly guildId: string | null;
  readonly userId: string;
  readonly expiresAt: number;
  readonly modal: APIModalInteractionResponseCallbackData;
}

export class PreparedModalStore {
  private readonly entries = new Map<string, PreparedModal>();

  public save(guildId: string | null, userId: string, modal: APIModalInteractionResponseCallbackData): string {
    this.prune();
    if (this.entries.size >= MAX_PREPARED_MODALS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const token = randomUUID();
    this.entries.set(token, { guildId, userId, modal, expiresAt: Date.now() + MODAL_TTL_MS });
    return `${preparedModalPrefix}${token}`;
  }

  public take(customId: string, guildId: string | null, userId: string): APIModalInteractionResponseCallbackData {
    if (!customId.startsWith(preparedModalPrefix)) throw new ValidationError('ปุ่มเปิดแบบฟอร์มไม่ถูกต้อง');
    this.prune();
    const token = customId.slice(preparedModalPrefix.length);
    const entry = this.entries.get(token);
    if (entry === undefined) throw new ValidationError('แบบฟอร์มนี้หมดอายุหรือเปิดไปแล้ว กรุณากดเมนูเดิมอีกครั้ง');
    if (entry.guildId !== guildId || entry.userId !== userId) {
      throw new AuthorizationError('แบบฟอร์มนี้เปิดได้เฉพาะผู้ที่กดเมนูเตรียมไว้');
    }
    this.entries.delete(token);
    return entry.modal;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}
