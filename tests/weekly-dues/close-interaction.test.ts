import { jest } from '@jest/globals';
import type { Interaction } from 'discord.js';
import { AuthorizationError, ValidationError } from '../../src/domain/errors.js';
import {
  WeeklyDuesInteractionHandler,
  type WeeklyDuesInteractionDependencies,
} from '../../src/infrastructure/discord/weekly-dues-interaction-handler.js';

const id = '11111111-1111-4111-8111-111111111111';
function fixture(role: string, modal = false, confirmation = 'ปิดรอบ') {
  const closeCollection = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ collection: { publicChannelId: null, publicMessageId: null } });
  const handler = new WeeklyDuesInteractionHandler({
    guildConfig: {
      get: () =>
        Promise.resolve({ devRoleId: 'DEV', headRoleId: 'HEAD', deputyRoleId: 'DEPUTY', activeMemberRoleId: 'MEMBER' }),
    },
    weeklyDues: { closeCollection },
  } as unknown as WeeklyDuesInteractionDependencies);
  const state = { deferred: false, replied: false };
  const showModal = jest.fn<() => Promise<void>>().mockResolvedValue();
  const interaction = {
    customId: `weekly:${modal ? 'close_modal' : 'close'}:${id}`,
    user: { id: 'actor' },
    guild: { id: 'guild', members: { fetch: () => Promise.resolve({ roles: { cache: new Map([[role, {}]]) } }) } },
    isButton: () => !modal,
    isModalSubmit: () => modal,
    isStringSelectMenu: () => false,
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    deferReply: () => {
      state.deferred = true;
      return Promise.resolve();
    },
    showModal,
    editReply: () => Promise.resolve(),
    fields: {
      getTextInputValue: (field: string) =>
        field === 'weekly:closure_confirmation' ? confirmation : 'ปิดยอดสัปดาห์นี้',
    },
  } as unknown as Interaction;
  return { handler, interaction, closeCollection, showModal };
}

describe('weekly manual close authorization', () => {
  it.each(['DEV', 'HEAD', 'DEPUTY'])('allows %s to open and submit the close form', async (role) => {
    const button = fixture(role);
    await button.handler.handle(button.interaction);
    expect(button.showModal).toHaveBeenCalledTimes(1);
    const modal = fixture(role, true);
    await modal.handler.handle(modal.interaction);
    expect(modal.closeCollection).toHaveBeenCalledWith(
      'guild',
      id,
      'actor',
      'ปิดยอดสัปดาห์นี้',
      expect.any(Date),
      true,
    );
  });
  it.each([false, true])('rejects a member even when using a forged close identifier (modal=%s)', async (modal) => {
    const f = fixture('MEMBER', modal);
    await expect(f.handler.handle(f.interaction)).rejects.toBeInstanceOf(AuthorizationError);
    expect(f.closeCollection).not.toHaveBeenCalled();
    expect(f.showModal).not.toHaveBeenCalled();
  });
  it('rechecks the current role on submission after the form was opened by an admin', async () => {
    const button = fixture('DEPUTY');
    await button.handler.handle(button.interaction);
    const downgraded = fixture('MEMBER', true);
    await expect(downgraded.handler.handle(downgraded.interaction)).rejects.toBeInstanceOf(AuthorizationError);
    expect(downgraded.closeCollection).not.toHaveBeenCalled();
  });
  it('does not close when the confirmation is missing or wrong', async () => {
    const f = fixture('DEV', true, 'ยกเลิก');
    await expect(f.handler.handle(f.interaction)).rejects.toBeInstanceOf(ValidationError);
    expect(f.closeCollection).not.toHaveBeenCalled();
  });
});
