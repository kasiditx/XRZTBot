import {
  MiruEmbedBuilder,
  buildMiruEmbed,
  formatPanelText,
} from '../../src/infrastructure/discord/theme.js';

describe('MIRU Discord theme', () => {
  it('appends the xᴄʀᴜɪᴢᴛ copyright to default and custom embed footers', () => {
    const defaultEmbed = new MiruEmbedBuilder().setTitle('ทดสอบ').toJSON();
    const customEmbed = new MiruEmbedBuilder()
      .setFooter({ text: 'หน้า 1/1' })
      .toJSON();
    const noticeEmbed = buildMiruEmbed({ title: 'สำเร็จ', module: 'Test' }).toJSON();

    expect(defaultEmbed.footer?.text).toContain('© xᴄʀᴜɪᴢᴛ');
    expect(customEmbed.footer?.text).toBe('╰─・หน้า 1/1 • © xᴄʀᴜɪᴢᴛ・✦');
    expect(noticeEmbed.footer?.text).toBe('╰─・ᴍɪʀᴜ sʏsᴛᴇᴍ • Test • © xᴄʀᴜɪᴢᴛ・✦');
  });

  it('adds a readable branded tail to component panels', () => {
    const panel = formatPanelText('✅', 'สำเร็จ', 'บันทึกข้อมูลแล้ว');

    expect(panel).toContain('### ╭─・✦ ✅ สำเร็จ ✦');
    expect(panel).toContain('> บันทึกข้อมูลแล้ว');
    expect(panel).toContain('╰─・ᴍɪʀᴜ sʏsᴛᴇᴍ • © xᴄʀᴜɪᴢᴛ・✦');
  });

  it('decorates titles, descriptions, and fields consistently', () => {
    const embed = new MiruEmbedBuilder()
      .setTitle('💸 รายจ่าย')
      .setDescription('รายละเอียด\nบรรทัดที่สอง')
      .addFields({ name: 'จำนวนเงิน', value: '1,000', inline: true })
      .toJSON();

    expect(embed.title).toBe('╭─・✦ 💸 รายจ่าย ✦');
    expect(embed.description).toBe('> รายละเอียด\n> บรรทัดที่สอง');
    expect(embed.fields?.[0]).toMatchObject({ name: '⌗・จำนวนเงิน', value: '> 1,000', inline: true });
  });
});
