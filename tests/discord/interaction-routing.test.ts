import { jest } from '@jest/globals';
import { MessageFlags, type Interaction, type InteractionReplyOptions } from 'discord.js';
import { AttendanceInteractionHandler, type AttendanceInteractionDependencies } from '../../src/infrastructure/discord/attendance-interaction-handler.js';
import { DiscordInteractionHandler, type InteractionHandlerDependencies } from '../../src/infrastructure/discord/interaction-handler.js';

const roundId = '00000000-0000-4000-8000-000000000001';

function setup(allowed = true, selection = false) {
  const fetchMember = jest.fn(() => new Promise((resolve) => {
    setTimeout(() => resolve({ roles: { cache: new Map(allowed ? [['member-role', {}]] : []) } }), 3_500);
  }));
  const getRound = jest.fn().mockImplementation(() => Promise.resolve({ mode: 'AIRDROP' }));
  const guildConfig = { get: () => Promise.resolve({
    devRoleId: null, headRoleId: null, deputyRoleId: null, activeMemberRoleId: 'member-role',
  }) };
  const members = { findByDiscordUserId: () => Promise.resolve({ status: 'ACTIVE' }) };
  const attendance = new AttendanceInteractionHandler({
    guildConfig, members, attendance: { getRound },
  } as unknown as AttendanceInteractionDependencies);
  const ignore = { handle: () => Promise.resolve(false) };
  const reportSystemError = jest.fn<() => void>();
  const logger = { warn: jest.fn(), error: jest.fn() };
  const handler = new DiscordInteractionHandler({
    guildConfig, members, activityInteractions: ignore, attendanceInteractions: attendance,
    fineInteractions: ignore, treasuryInteractions: ignore, weeklyDuesInteractions: ignore,
    weeklyItemsInteractions: ignore, stockInteractions: ignore, fightPositionInteractions: ignore,
    logger, reportSystemError,
  } as unknown as InteractionHandlerDependencies);
  const state = {
    id: 'interaction-id', createdTimestamp: Date.now(), user: { id: 'member' }, guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch: fetchMember } }, deferred: false, replied: false,
    customId: `attendance:${selection ? 'proof_method' : 'check_in'}:${roundId}`, values: ['FILE'],
    isRepliable: () => true, isButton: () => !selection, isStringSelectMenu: () => selection,
    isMessageComponent: () => true, isModalSubmit: () => false, isChatInputCommand: () => false,
  };
  const deferUpdate = jest.fn(() => { state.deferred = true; return Promise.resolve(); });
  const followUp = jest.fn<(options: InteractionReplyOptions) => Promise<{ id: string }>>().mockImplementation(() => {
    state.replied = true; return Promise.resolve({ id: 'private-reply' });
  });
  const reply = jest.fn(() => { state.replied = true; return Promise.resolve(); });
  const editReply = jest.fn(() => Promise.resolve());
  const showModal = jest.fn(() => Promise.resolve());
  const interaction = Object.assign(state, { deferUpdate, followUp, reply, editReply, showModal }) as unknown as Interaction;
  return { handler, interaction, state, deferUpdate, followUp, reply, editReply, showModal, getRound, reportSystemError };
}

describe('interaction routing under slow authorization', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-08T15:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('keeps the actual Airdrop button responsive while current member authorization is pending', async () => {
    const { handler, interaction, deferUpdate, followUp, reply, getRound } = setup();
    const running = handler.handle(interaction);
    await jest.advanceTimersByTimeAsync(800);
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(getRound).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_700);
    await running;
    expect(getRound).toHaveBeenCalledWith('guild-1', roundId);
    expect(reply).not.toHaveBeenCalled();
    expect(followUp.mock.calls[0]?.[0].flags).toBe(MessageFlags.Ephemeral);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps denied members unauthorized after acknowledgement and does not overwrite a shared announcement', async () => {
    const { handler, interaction, followUp, editReply, getRound, reportSystemError } = setup(false);
    const running = handler.handle(interaction);
    await jest.advanceTimersByTimeAsync(3_500);
    await running;
    expect(getRound).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp.mock.calls[0]?.[0].flags).toBe(MessageFlags.Ephemeral);
    expect(reportSystemError).not.toHaveBeenCalled();
  });

  it('creates a private continuation for a slow evidence form instead of sending an expired modal response', async () => {
    const { handler, interaction, deferUpdate, followUp, showModal } = setup(true, true);
    const running = handler.handle(interaction);
    await jest.advanceTimersByTimeAsync(3_500);
    await running;
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(showModal).not.toHaveBeenCalled();
    expect(followUp.mock.calls[0]?.[0].content).toContain('เปิดแบบฟอร์ม');
    expect(followUp.mock.calls[0]?.[0].flags).toBe(MessageFlags.Ephemeral);
  });

  it('returns an actionable private notice for unsupported old buttons', async () => {
    const { handler, interaction, state, reply, reportSystemError } = setup();
    state.customId = 'obsolete:button';
    await handler.handle(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reportSystemError).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
