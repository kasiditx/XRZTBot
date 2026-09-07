import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from 'discord.js';
import { ValidationError } from '../../domain/errors.js';

export function cancellationConfirmationRow(requiresPhysicalReturnCheck = true) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
    .setCustomId('cancellation:confirm')
    .setLabel(requiresPhysicalReturnCheck ? 'พิมพ์ ยืนยัน หลังตรวจการคืนเงิน/ของจริง' : 'พิมพ์ ยืนยัน หลังตรวจสอบผลกระทบ')
    .setPlaceholder('ยืนยัน')
    .setStyle(TextInputStyle.Short).setRequired(true));
}

export function requireCancellationConfirmation(interaction: ModalSubmitInteraction): void {
  if (interaction.fields.getTextInputValue('cancellation:confirm').trim() !== 'ยืนยัน') {
    throw new ValidationError('กรุณาพิมพ์ ยืนยัน หลังตรวจสอบผลกระทบของรายการแล้ว');
  }
}

export function buildReasonedCancellationModal(customId: string, title: string) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId('cancellation:reason').setLabel('เหตุผลที่ยกเลิก')
      .setStyle(TextInputStyle.Paragraph).setMinLength(2).setMaxLength(500).setRequired(true)),
    cancellationConfirmationRow(false),
  );
}
