import {
  buildAttendanceAnnouncement,
  buildAttendanceModeSelector,
  buildAttendanceProofLog,
  buildAttendanceProofModal,
  buildAttendanceProofRejectionModal,
  buildCreateRoundModal,
  buildRecurringScheduleModal,
} from '../../src/infrastructure/discord/attendance-components.js';
import type { AttendanceRoundView } from '../../src/modules/attendance/service.js';

describe('attendance Discord components', () => {
  it('lets Admin choose Airdrop or general for both Manual and Auto', () => {
    for (const purpose of ['MANUAL', 'AUTO'] as const) {
      const payload = buildAttendanceModeSelector(purpose);
      const options = payload.components[0]!.toJSON().components[0];

      expect(options !== undefined && 'options' in options ? options.options.map((option) => option.value) : []).toEqual([
        'AIRDROP',
        'GENERAL',
      ]);
    }
  });

  it('uses an event time and lenient margins for a Manual Airdrop', () => {
    const modal = buildCreateRoundModal('AIRDROP', {
      title: 'Airdrop 21:00',
      eventAt: '27/08/2569 21:00',
      opensAt: '27/08/2569 20:50',
      closesAt: '27/08/2569 21:10',
    }).toJSON();

    expect(modal.custom_id).toBe('attendance:create_modal:AIRDROP');
    expect(modal.components).toHaveLength(4);
  });

  it('uses explicit open and close datetimes for a Manual general session', () => {
    const modal = buildCreateRoundModal('GENERAL', {
      title: 'ซ้อมไฟต์',
      eventAt: '27/08/2569 21:00',
      opensAt: '27/08/2569 19:00',
      closesAt: '27/08/2569 22:00',
    }).toJSON();

    expect(modal.custom_id).toBe('attendance:create_modal:GENERAL');
    expect(modal.components).toHaveLength(3);
  });

  it('configures one recurring entry per selected attendance mode', () => {
    const airdrop = buildRecurringScheduleModal('AIRDROP').toJSON();
    const general = buildRecurringScheduleModal('GENERAL').toJSON();

    expect(airdrop.custom_id).toBe('attendance:recurring_modal:AIRDROP');
    expect(airdrop.components).toHaveLength(5);
    expect(JSON.stringify(airdrop.components)).toContain('"value":"10"');
    expect(general.custom_id).toBe('attendance:recurring_modal:GENERAL');
    expect(general.components).toHaveLength(4);
  });

  it('uses the selected evidence method for an Airdrop check-in', () => {
    const fileModal = buildAttendanceProofModal(AIRDROP_ROUND_ID, 'FILE').toJSON();
    const linkModal = buildAttendanceProofModal(AIRDROP_ROUND_ID, 'LINK').toJSON();

    expect(fileModal.custom_id).toBe(`attendance:proof_modal:FILE:${AIRDROP_ROUND_ID}`);
    expect(fileModal.components[0]).toMatchObject({
      component: { type: 19, min_values: 1, max_values: 1, required: true },
    });
    expect(linkModal.custom_id).toBe(`attendance:proof_modal:LINK:${AIRDROP_ROUND_ID}`);
    expect(linkModal.components[0]).toMatchObject({
      component: { type: 4, custom_id: 'attendance:proof_link', required: true },
    });
  });

  it('asks for proof only on the Airdrop announcement', () => {
    const airdrop = buildAttendanceAnnouncement(roundView('AIRDROP'));
    const general = buildAttendanceAnnouncement(roundView('GENERAL'));

    expect(airdrop.embeds[0]?.toJSON().description).toContain('ตัวละครของตัวเอง');
    expect(airdrop.components[0]?.toJSON().components[0]).toMatchObject({ label: 'แนบรูปเช็กชื่อ' });
    expect(general.components[0]?.toJSON().components[0]).toMatchObject({ label: 'เช็กชื่อ' });
  });

  it('lets Admin reject an Airdrop proof with a required reason', () => {
    const round = roundView('AIRDROP').round;
    const pending = buildAttendanceProofLog(round, {
      discordUserId: '200000000000000001',
      inGameName: 'Alpha',
    });
    const action = pending.components[0]?.toJSON().components[0];

    expect(action).toMatchObject({
      custom_id: `attendance:proof_reject:${AIRDROP_ROUND_ID}`,
      label: 'ปฏิเสธ',
      disabled: false,
    });

    const modal = buildAttendanceProofRejectionModal(AIRDROP_ROUND_ID, PROOF_MESSAGE_ID).toJSON();
    expect(modal.custom_id).toBe(`attendance:proof_reject_modal:${AIRDROP_ROUND_ID}:${PROOF_MESSAGE_ID}`);
    expect(modal.components[0]).toMatchObject({
      components: [{ custom_id: 'attendance:proof_rejection_reason', required: true, min_length: 2 }],
    });

    const rejected = buildAttendanceProofLog(round, {
      discordUserId: '200000000000000001',
      inGameName: 'Alpha',
    }, {
      status: 'REJECTED',
      rejectionReason: 'รูปไม่เห็นรายชื่อในวอ',
      decidedByDiscordUserId: '100000000000000001',
      decidedAt: new Date('2026-08-27T14:05:00.000Z'),
    });
    const rejectedEmbed = rejected.embeds[0]?.toJSON();
    expect(rejectedEmbed?.title).toContain('ปฏิเสธหลักฐานเช็กชื่อ Airdrop');
    expect(rejectedEmbed?.fields?.find((field) => field.name.includes('เหตุผลที่ปฏิเสธ'))?.value)
      .toContain('รูปไม่เห็นรายชื่อในวอ');
    expect(rejected.components[0]?.toJSON().components[0]).toMatchObject({ disabled: true });
  });
});

const AIRDROP_ROUND_ID = '11111111-1111-4111-8111-111111111111';
const PROOF_MESSAGE_ID = '300000000000000001';

function roundView(mode: 'AIRDROP' | 'GENERAL'): AttendanceRoundView {
  const now = new Date('2026-08-27T14:00:00.000Z');
  return {
    round: {
      id: AIRDROP_ROUND_ID,
      guildId: 'guild',
      requestId: 'request',
      title: mode === 'AIRDROP' ? 'Airdrop 21:00' : 'ซ้อมไฟต์',
      mode,
      attendanceDate: '2026-08-27',
      eventAt: mode === 'AIRDROP' ? now : null,
      opensAt: new Date('2026-08-27T13:50:00.000Z'),
      closesAt: new Date('2026-08-27T14:10:00.000Z'),
      emergencyLeaveCutoff: new Date('2026-08-27T16:59:59.999Z'),
      status: 'OPEN',
      sourceScheduleId: null,
      announcementChannelId: null,
      announcementMessageId: null,
      createdByDiscordUserId: '100000000000000001',
      createdAt: now,
      updatedAt: now,
    },
    present: [],
    leave: [],
    emergencyLeave: [],
    absent: [],
    pending: [],
    activeLeaves: [],
  };
}
