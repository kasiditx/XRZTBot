import { MessageFlags, type InteractionReplyOptions, type RepliableInteraction } from 'discord.js';
import { ValidationError } from '../../src/domain/errors.js';
import { DateTimePicker, pickerDateTimeToDate } from '../../src/infrastructure/discord/date-time-picker.js';

describe('DateTimePicker', () => {
  it('converts a selected Bangkok local datetime to the correct instant', () => {
    expect(pickerDateTimeToDate('2026-08-27T19:30', 'Asia/Bangkok', 'เวลาเริ่ม').toISOString())
      .toBe('2026-08-27T12:30:00.000Z');
  });

  it('rejects malformed or impossible selected datetimes', () => {
    expect(() => pickerDateTimeToDate('27/08/69 19:30', 'Asia/Bangkok', 'เวลาเริ่ม')).toThrow(ValidationError);
    expect(() => pickerDateTimeToDate('2026-02-31T19:30', 'Asia/Bangkok', 'เวลาเริ่ม')).toThrow(ValidationError);
  });

  it('starts with an ephemeral 25-day date selector', async () => {
    let captured: InteractionReplyOptions | undefined;
    const reply = (payload: InteractionReplyOptions): Promise<void> => {
      captured = payload;
      return Promise.resolve();
    };
    const interaction = { user: { id: '100000000000000001' }, reply } as unknown as RepliableInteraction;
    const picker = new DateTimePicker();

    await picker.start(interaction, {
      flow: 'test-flow',
      continueCustomIdPrefix: 'test:continue:',
      fields: [{ key: 'date', label: 'วันที่ทดสอบ', type: 'DATE', initialDate: '2026-08-27' }],
      timezone: 'Asia/Bangkok',
    });

    expect(captured?.flags).toBe(MessageFlags.Ephemeral);
    expect(captured?.components).toHaveLength(2);
  });
});
