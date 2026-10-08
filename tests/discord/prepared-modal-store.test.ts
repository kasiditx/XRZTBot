import { jest } from '@jest/globals';
import { PreparedModalStore } from '../../src/infrastructure/discord/prepared-modal-store.js';

const modal = { custom_id: 'original:modal', title: 'แบบฟอร์ม', components: [] };

describe('prepared modal access and expiry', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-08T15:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('allows only the original user in the original guild and does not consume another user\'s form', () => {
    const store = new PreparedModalStore();
    const token = store.save('guild-1', 'owner', modal);
    expect(() => store.take(token, 'guild-1', 'stranger')).toThrow('เฉพาะผู้ที่กดเมนู');
    expect(() => store.take(token, 'other-guild', 'owner')).toThrow('เฉพาะผู้ที่กดเมนู');
    expect(store.take(token, 'guild-1', 'owner')).toEqual(modal);
    expect(() => store.take(token, 'guild-1', 'owner')).toThrow('หมดอายุหรือเปิดไปแล้ว');
  });

  it('expires a form at the two-minute boundary', () => {
    const store = new PreparedModalStore();
    const token = store.save('guild-1', 'owner', modal);
    jest.advanceTimersByTime(120_000);
    expect(() => store.take(token, 'guild-1', 'owner')).toThrow('หมดอายุ');
  });

  it('bounds memory and evicts the oldest form when its capacity is reached', () => {
    const store = new PreparedModalStore();
    const oldest = store.save('guild-1', 'owner', modal);
    let newest = '';
    for (let index = 0; index < 500; index += 1) newest = store.save('guild-1', 'owner', modal);
    expect(() => store.take(oldest, 'guild-1', 'owner')).toThrow('หมดอายุ');
    expect(store.take(newest, 'guild-1', 'owner')).toEqual(modal);
  });
});
