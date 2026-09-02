import {
  buildTreasuryWithdrawalModal,
  buildTreasuryWithdrawalPanel,
  buildTreasuryWithdrawalRequestLog,
} from '../../src/infrastructure/discord/treasury-components.js';
import type { TreasuryWithdrawalRequestView } from '../../src/modules/treasury-withdrawals/service.js';

const now = new Date('2026-08-28T03:00:00.000Z');

describe('treasury withdrawal Discord components', () => {
  it('keeps the member channel panel limited to creating a withdrawal request', () => {
    const panel = buildTreasuryWithdrawalPanel();
    const customIds = panel.components[0]?.toJSON().components.map((button) => (
      'custom_id' in button ? button.custom_id : null
    ));

    expect(customIds).toEqual(['treasury:withdrawal_request']);
  });

  it('requests only amount and purpose without an evidence upload', () => {
    const modal = buildTreasuryWithdrawalModal().toJSON();

    expect(modal.components).toHaveLength(2);
    expect(modal.components.map((label) => ('component' in label ? label.component.type : null))).toEqual([4, 4]);
  });

  it('shows approval actions only while the request is pending', () => {
    const pending = buildTreasuryWithdrawalRequestLog(view('PENDING'));
    const approved = buildTreasuryWithdrawalRequestLog(view('APPROVED'));

    expect(pending.components[0]?.toJSON().components.map((button) => (
      'custom_id' in button ? button.custom_id : null
    ))).toEqual([
      'treasury:withdrawal_approve:11111111-1111-4111-8111-111111111111',
      'treasury:withdrawal_reject:11111111-1111-4111-8111-111111111111',
      'treasury:withdrawal_cancel:11111111-1111-4111-8111-111111111111',
    ]);
    expect(approved.components).toEqual([]);
  });
});

function view(status: TreasuryWithdrawalRequestView['request']['status']): TreasuryWithdrawalRequestView {
  return {
    request: {
      id: '11111111-1111-4111-8111-111111111111',
      guildId: 'guild',
      clientRequestId: 'request',
      requesterMemberId: '22222222-2222-4222-8222-222222222222',
      amount: 100_000,
      reason: 'ซื้อของใช้ในแก๊ง',
      status,
      treasuryEntryId: status === 'APPROVED' ? '33333333-3333-4333-8333-333333333333' : null,
      publicChannelId: 'channel',
      publicMessageId: 'message',
      decidedAt: status === 'PENDING' ? null : now,
      decidedByDiscordUserId: status === 'PENDING' ? null : '400000000000000001',
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    },
    requester: {
      discordUserId: '400000000000000002',
      inGameName: 'Alpha',
    },
  };
}
