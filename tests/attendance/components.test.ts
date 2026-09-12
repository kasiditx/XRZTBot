import {
  buildAttendanceAnnouncement,
  buildAttendanceCancellationModal,
  buildAttendanceModeSelector,
  buildAttendanceProofLog,
  buildAttendanceProofModal,
  buildAttendanceProofRejectionModal,
  buildCreateRoundModal,
  buildLeaveEditModal,
  buildLeaveLog,
  buildLeaveModal,
  buildRecurringScheduleModal,
} from '../../src/infrastructure/discord/attendance-components.js';
import type { AttendanceRoundView, AttendanceSchedule, LeaveView } from '../../src/modules/attendance/service.js';

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

  it('adds round cancellation with a required reason and confirmation', () => {
    const payload = buildAttendanceAnnouncement(roundView('GENERAL'));
    const buttons = payload.components[0]?.toJSON().components;
    const modal = buildAttendanceCancellationModal(AIRDROP_ROUND_ID).toJSON();

    expect(buttons?.[1]).toMatchObject({
      custom_id: `attendance:cancel:${AIRDROP_ROUND_ID}`,
      label: 'ยกเลิกรอบ',
      disabled: false,
    });
    expect(modal.custom_id).toBe(`attendance:cancel_modal:${AIRDROP_ROUND_ID}`);
    expect(modal.components).toHaveLength(2);
    expect(modal.components[0]).toMatchObject({
      components: [{ custom_id: 'cancellation:reason', required: true }],
    });
    expect(modal.components[1]).toMatchObject({
      components: [{ custom_id: 'cancellation:confirm', required: true }],
    });
  });

  it('shows a cancelled round without counting its preserved member results', () => {
    const view = roundView('GENERAL');
    const cancelledAt = new Date('2026-08-27T14:05:00.000Z');
    const payload = buildAttendanceAnnouncement({
      ...view,
      round: {
        ...view.round,
        status: 'CANCELLED',
        cancelledAt,
        cancelledByDiscordUserId: '100000000000000001',
        cancellationReason: 'เปิดรอบผิดเวลา',
        updatedAt: cancelledAt,
      },
      present: [{
        memberId: 'member-1',
        discordUserId: '200000000000000001',
        inGameName: 'Alpha',
        checkedInAt: new Date('2026-08-27T14:01:00.000Z'),
        proofChannelId: null,
        proofMessageId: null,
        result: 'PRESENT',
      }],
    });
    const embed = payload.embeds[0]?.toJSON();
    const buttons = payload.components[0]?.toJSON().components;

    expect(embed?.color).toBe(0xed4245);
    expect(embed?.footer?.text).toContain('ไม่นำผลไปนับ');
    expect(embed?.description).toContain('เปิดรอบผิดเวลา');
    expect(embed?.description).not.toContain('Alpha');
    expect(buttons?.every((button) => 'disabled' in button && button.disabled === true)).toBe(true);
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

  it('lets a member choose all night or multiple recurring activities in the leave modal', () => {
    const modal = buildLeaveModal('13/09/2569', '13/09/2569', [
      schedule('schedule-airdrop', 'Airdrop 20:00', 'AIRDROP'),
      schedule('schedule-loop', 'Loop', 'GENERAL'),
    ]).toJSON();

    expect(modal.components).toHaveLength(4);
    expect(modal.components[2]).toMatchObject({
      component: {
        custom_id: 'leave:scope',
        min_values: 1,
        max_values: 3,
        options: [
          expect.objectContaining({ label: 'ทั้งคืน', value: 'ALL', default: true }),
          expect.objectContaining({ label: 'Airdrop 20:00', value: 'schedule-airdrop' }),
          expect.objectContaining({ label: 'Loop', value: 'schedule-loop' }),
        ],
      },
    });
  });

  it('shows and retains the selected activity scope when editing a leave', () => {
    const selected = schedule('schedule-loop', 'Loop', 'GENERAL');
    const view = leaveView(false, [selected]);
    const modal = buildLeaveEditModal(view, '13/09/2569', '13/09/2569', [selected]).toJSON();
    const log = buildLeaveLog(view).embeds[0]?.toJSON();

    expect(modal.components[2]).toMatchObject({
      component: {
        options: [
          expect.objectContaining({ value: 'ALL', default: false }),
          expect.objectContaining({ value: selected.id, default: true }),
        ],
      },
    });
    expect(log?.fields?.find((field) => field.name.includes('ช่วงกิจกรรม'))?.value).toContain('Loop');
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
      cancelledAt: null,
      cancelledByDiscordUserId: null,
      cancellationReason: null,
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

function schedule(id: string, name: string, mode: 'AIRDROP' | 'GENERAL'): AttendanceSchedule {
  const now = new Date('2026-09-13T00:00:00.000Z');
  return {
    id,
    guildId: 'guild',
    requestId: `request-${id}`,
    name,
    mode,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    opensAtLocalTime: mode === 'GENERAL' ? '20:10' : null,
    closesAtLocalTime: mode === 'GENERAL' ? '22:50' : null,
    eventAtLocalTime: mode === 'AIRDROP' ? '20:00' : null,
    opensBeforeMinutes: mode === 'AIRDROP' ? 10 : null,
    closesAfterMinutes: mode === 'AIRDROP' ? 10 : null,
    isActive: true,
    createdByDiscordUserId: '100000000000000001',
    createdAt: now,
    updatedAt: now,
  };
}

function leaveView(allRounds: boolean, schedules: readonly AttendanceSchedule[]): LeaveView {
  const now = new Date('2026-09-13T00:00:00.000Z');
  return {
    discordUserId: '200000000000000001',
    inGameName: 'Alpha',
    schedules,
    leave: {
      id: '11111111-1111-4111-8111-111111111111',
      guildId: 'guild',
      requestId: 'leave-request',
      memberId: 'member-id',
      startsOn: '2026-09-13',
      endsOn: '2026-09-13',
      allRounds,
      reason: 'ติดธุระ',
      status: 'ACTIVE',
      submittedAt: now,
      cancelledAt: null,
      publicChannelId: null,
      publicMessageId: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}
