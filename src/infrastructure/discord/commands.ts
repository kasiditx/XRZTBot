import {
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

export const commandNames = {
  register: 'register',
  admin: 'mirubot',
} as const;

const registerCommand = new SlashCommandBuilder()
  .setName(commandNames.register)
  .setDescription('ลงทะเบียนสมาชิกแก๊ง');

const adminCommand = new SlashCommandBuilder()
  .setName(commandNames.admin)
  .setDescription('จัดการ MiruBot')
  .addSubcommand((command) =>
    command
      .setName('setup-roles')
      .setDescription('กำหนด Role ของระบบ (ครั้งแรกใช้สิทธิ์ Server Administrator)')
      .addRoleOption((option) => option.setName('dev').setDescription('Role Dev').setRequired(true))
      .addRoleOption((option) => option.setName('head').setDescription('Role หัวแก๊ง').setRequired(true))
      .addRoleOption((option) => option.setName('deputy').setDescription('Role รองแก๊ง').setRequired(true))
      .addRoleOption((option) => option.setName('member').setDescription('Role สมาชิกที่ใช้งานระบบ').setRequired(true))
      .addRoleOption((option) => option.setName('former').setDescription('Role อดีตสมาชิก/พี่น้อง').setRequired(true)),
  )
  .addSubcommand((command) =>
    command
      .setName('set-channel')
      .setDescription('กำหนด Channel ปลายทาง')
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription('ประเภท Channel')
          .setRequired(true)
          .addChoices(
            { name: 'Control Panel', value: 'controlChannelId' },
            { name: 'ลงทะเบียนสมาชิก', value: 'memberChannelId' },
            { name: 'คำขอลงทะเบียน (หัวแก๊ง/รองแก๊ง)', value: 'registrationRequestChannelId' },
            { name: 'รายชื่อสมาชิกปัจจุบัน', value: 'memberRosterChannelId' },
            { name: 'กิจกรรม', value: 'activityChannelId' },
            { name: 'Log กิจกรรม', value: 'activityLogChannelId' },
            { name: 'เช็กชื่อ', value: 'attendanceChannelId' },
            { name: 'รายการเช็กชื่อ (หลักฐาน Airdrop)', value: 'attendanceLogChannelId' },
            { name: 'แจ้งลา', value: 'leaveChannelId' },
            { name: 'Log แจ้งลา', value: 'leaveLogChannelId' },
            { name: 'ค่าปรับ', value: 'fineChannelId' },
            { name: 'Log ค่าปรับ', value: 'fineLogChannelId' },
            { name: 'Log การเงินรวม (เงินแก๊ง)', value: 'treasuryChannelId' },
            { name: 'คำขอเบิกเงินแก๊ง', value: 'treasuryWithdrawalChannelId' },
            { name: 'Log เบิกเงินแก๊ง', value: 'treasuryWithdrawalLogChannelId' },
            { name: 'ส่งเงินรายสัปดาห์', value: 'weeklyDuesChannelId' },
            { name: 'Log ส่งเงินรายสัปดาห์', value: 'weeklyDuesLogChannelId' },
            { name: 'Stock', value: 'stockChannelId' },
            { name: 'Log Stock รวม', value: 'stockLogChannelId' },
            { name: 'Log เบิกของ', value: 'withdrawalLogChannelId' },
            { name: 'Log ส่งของ', value: 'depositLogChannelId' },
            { name: 'ตำแหน่ง Fight', value: 'fightPositionChannelId' },
            { name: 'Audit (หัวแก๊ง/รองแก๊ง/Dev)', value: 'auditChannelId' },
          ),
      )
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel ที่ต้องการใช้')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((command) => command.setName('panel').setDescription('สร้างหรืออัปเดต Control Panel ใน Channel นี้'))
  .addSubcommand((command) => command.setName('publish-registration').setDescription('ส่งแผงลงทะเบียนไปยัง Channel สมาชิก'))
  .addSubcommand((command) => command.setName('publish-member-roster').setDescription('สร้างหรืออัปเดตรายชื่อสมาชิกปัจจุบัน'))
  .addSubcommand((command) =>
    command
      .setName('add-member')
      .setDescription('เพิ่มสมาชิกเข้าทะเบียนโดยตรง')
      .addUserOption((option) => option.setName('user').setDescription('Discord user').setRequired(true))
      .addStringOption((option) => option.setName('name').setDescription('ชื่อในเมือง').setMinLength(2).setMaxLength(80).setRequired(true)),
  )
  .addSubcommand((command) =>
    command
      .setName('remove-member')
      .setDescription('ให้ออกจากแก๊งและเปลี่ยน Role เป็นอดีตสมาชิก/พี่น้อง')
      .addUserOption((option) => option.setName('user').setDescription('Discord user').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('เหตุผล').setMinLength(2).setMaxLength(500).setRequired(true)),
  )
  .addSubcommand((command) => command.setName('health').setDescription('ตรวจสถานะ Bot และ Database'));

export async function registerGuildCommands(token: string, applicationId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: [registerCommand.toJSON(), adminCommand.toJSON()],
  });
}
