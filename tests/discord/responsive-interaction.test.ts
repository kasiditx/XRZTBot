import { jest } from '@jest/globals';
import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
  type InteractionReplyOptions, type RepliableInteraction } from 'discord.js';
import { PreparedModalStore } from '../../src/infrastructure/discord/prepared-modal-store.js';
import { ResponsiveInteraction } from '../../src/infrastructure/discord/responsive-interaction.js';

function modal() {
  return new ModalBuilder().setCustomId('attendance:proof_modal:round-1').setTitle('ส่งหลักฐาน').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('proof').setLabel('หลักฐาน').setStyle(TextInputStyle.Short),
    ),
  );
}

function setup(component = true, store = new PreparedModalStore(), userId = 'owner', guildId = 'guild-1') {
  const state = {
    createdTimestamp: Date.now(), guildId, user: { id: userId }, deferred: false, replied: false,
    isMessageComponent: () => component, isModalSubmit: () => !component, isButton: () => component,
  };
  const ensureFresh = () => {
    if (Date.now() - state.createdTimestamp >= 3_000) throw new Error('Unknown interaction');
    if (state.deferred || state.replied) throw new Error('Already acknowledged');
  };
  const deferUpdate = jest.fn<() => Promise<void>>().mockImplementation(() => {
    ensureFresh(); state.deferred = true; return Promise.resolve();
  });
  const deferReply = jest.fn<() => Promise<void>>().mockImplementation(() => {
    ensureFresh(); state.deferred = true; return Promise.resolve();
  });
  const reply = jest.fn<() => Promise<void>>().mockImplementation(() => {
    ensureFresh(); state.replied = true; return Promise.resolve();
  });
  const update = jest.fn<() => Promise<void>>().mockImplementation(() => {
    ensureFresh(); state.replied = true; return Promise.resolve();
  });
  const showModal = jest.fn<() => Promise<void>>().mockImplementation(() => {
    ensureFresh(); state.replied = true; return Promise.resolve();
  });
  const followUp = jest.fn<(options: InteractionReplyOptions) => Promise<{ id: string }>>().mockImplementation(() => {
    state.replied = true; return Promise.resolve({ id: 'private-reply' });
  });
  const editReply = jest.fn<() => Promise<void>>().mockResolvedValue();
  const editMessage = jest.fn<() => Promise<void>>().mockResolvedValue();
  const interaction = Object.assign(state, {
    deferUpdate, deferReply, reply, update, showModal, followUp, editReply, webhook: { editMessage },
  }) as unknown as RepliableInteraction;
  const response = new ResponsiveInteraction(interaction, store);
  response.start();
  return { response, state, interaction, deferUpdate, deferReply, reply, update, showModal, followUp, editReply, editMessage, store };
}

function preparedButtonId(followUp: ReturnType<typeof setup>['followUp']): string {
  const components = JSON.parse(JSON.stringify(followUp.mock.calls.at(-1)?.[0].components)) as { components: { custom_id: string }[] }[];
  const id = components[0]?.components[0]?.custom_id;
  if (id === undefined) throw new Error('Missing prepared modal button');
  return id;
}

describe('responsive Discord interactions', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-08T15:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('preserves the normal fast reply and clears its acknowledgement timer', async () => {
    const { response, reply, deferUpdate } = setup();
    await response.reply({ content: 'พร้อม', flags: MessageFlags.Ephemeral });
    await jest.advanceTimersByTimeAsync(4_000);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('acknowledges a slow button before the deadline and sends its private result without overwriting the panel', async () => {
    const { response, deferUpdate, reply, followUp, editReply } = setup();
    await jest.advanceTimersByTimeAsync(3_500);
    await response.reply({ content: 'เมนูพร้อม', flags: MessageFlags.Ephemeral });
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({ content: 'เมนูพร้อม', flags: MessageFlags.Ephemeral });
  });

  it('keeps a delayed component update on the original message', async () => {
    const { response, deferUpdate, update, editReply, followUp } = setup();
    await jest.advanceTimersByTimeAsync(4_000);
    await response.update({ content: 'หน้าถัดไป' });
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: 'หน้าถัดไป' });
    expect(followUp).not.toHaveBeenCalled();
  });

  it('preserves explicit deferReply and deferUpdate on fast paths', async () => {
    const privateResult = setup();
    await privateResult.response.deferReply({ flags: MessageFlags.Ephemeral });
    await jest.advanceTimersByTimeAsync(3_500);
    await privateResult.response.editReply({ content: 'สำเร็จ' });
    expect(privateResult.deferReply).toHaveBeenCalledTimes(1);
    expect(privateResult.deferUpdate).not.toHaveBeenCalled();
    expect(privateResult.editReply).toHaveBeenCalledWith({ content: 'สำเร็จ' });
    const originalMessage = setup();
    await originalMessage.response.deferUpdate();
    await originalMessage.response.editReply({ content: 'อัปเดต' });
    expect(originalMessage.deferUpdate).toHaveBeenCalledTimes(1);
    expect(originalMessage.followUp).not.toHaveBeenCalled();
  });

  it('reconciles explicit deferReply after automatic deferral without double acknowledgement', async () => {
    const { response, deferUpdate, deferReply, followUp, editReply, editMessage } = setup();
    await jest.advanceTimersByTimeAsync(3_500);
    await response.deferReply({ flags: MessageFlags.Ephemeral });
    await response.editReply({ content: 'กำลังส่ง' });
    await response.editReply({ content: 'ส่งสำเร็จ' });
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith('private-reply', { content: 'ส่งสำเร็จ' });
  });

  it('defers slow modal submissions with an ephemeral response', async () => {
    const { response, deferReply, deferUpdate, editReply } = setup(false);
    await jest.advanceTimersByTimeAsync(3_500);
    await response.deferReply({ flags: MessageFlags.Ephemeral });
    await response.editReply({ content: 'บันทึกแล้ว' });
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: 'บันทึกแล้ว' });
  });

  it('opens fast forms immediately without a continuation button', async () => {
    const { response, showModal, followUp, deferUpdate } = setup();
    await response.showModal(modal());
    await jest.advanceTimersByTimeAsync(4_000);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(deferUpdate).not.toHaveBeenCalled();
  });

  it('keeps slow modal preparation usable through a fresh owner-bound button', async () => {
    const original = setup();
    const expectedModal = modal();
    await jest.advanceTimersByTimeAsync(3_500);
    await original.response.showModal(expectedModal);
    expect(original.showModal).not.toHaveBeenCalled();
    const customId = preparedButtonId(original.followUp);
    const next = setup(true, original.store);
    await next.response.openPreparedModal(customId);
    expect(next.showModal).toHaveBeenCalledWith(expectedModal.toJSON());
    expect(next.deferUpdate).not.toHaveBeenCalled();
    expect(() => original.store.take(customId, 'guild-1', 'owner')).toThrow('หมดอายุหรือเปิดไปแล้ว');
  });

  it('keeps permission and validation errors private after automatic acknowledgement', async () => {
    const { response, editReply, followUp } = setup();
    await jest.advanceTimersByTimeAsync(3_500);
    await response.sendError({ content: 'ไม่มีสิทธิ์' });
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({ content: 'ไม่มีสิทธิ์', flags: MessageFlags.Ephemeral });
  });

  it('waits for an acknowledgement already in flight instead of replying twice', async () => {
    const { response, state, deferUpdate, followUp } = setup();
    let complete: (() => void) | undefined;
    deferUpdate.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await jest.advanceTimersByTimeAsync(800);
    const replying = response.reply({ content: 'พร้อม', flags: MessageFlags.Ephemeral });
    expect(followUp).not.toHaveBeenCalled();
    // Discord.js sets deferred when the acknowledgement response arrives.
    state.deferred = true;
    complete?.();
    await replying;
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('propagates failed acknowledgements without starting another request with an expired token', async () => {
    const { response, deferUpdate, reply, followUp } = setup();
    deferUpdate.mockRejectedValueOnce(new Error('Unknown interaction'));
    await jest.advanceTimersByTimeAsync(800);
    await expect(response.reply({ content: 'พร้อม' })).rejects.toThrow('Unknown interaction');
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it('stops the deadline timer when handling finishes', async () => {
    const { response, deferUpdate } = setup();
    response.stop();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
