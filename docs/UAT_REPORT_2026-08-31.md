# Discord UAT Report — 2026-08-31

## สรุปผล

ผลรวม: **ผ่านแบบมีเงื่อนไข (Conditional Pass)**

ทดสอบกับ MiruBot ที่เชื่อมต่อ Discord Server จริงและ PostgreSQL จริง โดยรอบนี้ใช้หลักฐานธุรกรรมที่มีอยู่แล้ว ไม่สร้าง Item, สมาชิก หรือธุรกรรมปลอมเพิ่มใน Server

## Baseline

- Bot, Discord และ Database health ผ่าน
- Role และ Channel configuration ครบ 31 จุด
- Bot มี `Manage Roles` และอยู่เหนือ Role หัวแก๊ง รองแก๊ง สมาชิก และอดีตสมาชิก
- Bot มี `View Channel`, `Send Messages`, `Embed Links`, `Attach Files` และ `Read Message History` ครบทุก Channel ที่ตั้งค่า
- Control Panel มีปุ่มครบ 8 ระบบและทุกปุ่มอยู่ในสถานะใช้งาน
- Registration, Leave, Treasury Withdrawal และ Stock Panel อยู่บน Discord และมีปุ่มใช้งานตรงตามระบบ

## ผล UAT จาก Discord และ Database จริง

| ระบบ | ผล | หลักฐานที่ตรวจ |
|---|---|---|
| สมาชิก | ผ่าน | สมาชิก ACTIVE 13 คน, ลงทะเบียนและอนุมัติครบ, Registration Panel/Request/Member Roster ยังอยู่บน Discord |
| ตำแหน่งกำกับ | ผ่าน | หัวแก๊ง 1 คน, รองแก๊ง 1 คน, บัญชีแก๊ง 1 คน; Role จริงตรงกับ Database และ Role sync ล่าสุดสำเร็จ |
| ตำแหน่ง Fight | ผ่าน | ตำแหน่งใช้งาน 7 ตำแหน่ง, มอบแล้ว 8 คน, ไม่มี assignment ไปยังสมาชิกหรือตำแหน่งที่ไม่ใช้งาน, Summary อยู่บน Discord |
| กิจกรรมสะสมคะแนน | ผ่าน | สร้าง, publish, open, ส่งกิจกรรม, ปิด และ Activity log สำเร็จ; มี Score item 2 รายการ |
| กิจกรรมส่งผลงาน | ผ่านบางส่วน | กิจกรรมเปิดอยู่, ปุ่มส่งกิจกรรม/สรุปผลงานใช้งานได้ และมี Submission จริง |
| เช็กชื่อ | ผ่าน | รอบจริง publish/open/reminder/close สำเร็จ; รอบปิดแล้วไม่มีผล `PENDING` เหลือ |
| แจ้งลา | ผ่านบางส่วน | ส่งและยกเลิกใบลาจริง 2 รายการ, Public log อยู่บน Discord |
| ค่าปรับ | ผ่าน | สร้างค่าปรับ, ส่งหลักฐาน, อนุมัติ, เปลี่ยนเป็น PAID และเพิ่มรายรับเข้า Treasury สำเร็จ |
| เงินกองกลาง | ผ่าน | Ledger 5 รายการ; ผลรวมรายการ 594,100 ตรงกับ balance ล่าสุด 594,100 และ Public panel/log อยู่ครบ |
| เบิกเงินแก๊ง | ผ่าน | ทดสอบอนุมัติ, ปฏิเสธ และยกเลิกอย่างละ 1 รายการ; เฉพาะรายการอนุมัติเชื่อม Expense ใน Ledger |
| เงินรายสัปดาห์ | ผ่านบางส่วน | สร้างรอบ, snapshot สมาชิก 8 คน, ส่งหลักฐาน, อนุมัติและปฏิเสธสำเร็จ; ยอดอนุมัติเข้า Treasury |
| Stock/เบิกของ/ส่งของ | รอทดสอบ | Panel และปุ่มอยู่ครบ แต่ Server ยังไม่มี Inventory item, batch, withdrawal หรือ deposit จริง |
| Audit | ผ่าน | Audit 85 รายการ publish ครบ ไม่มีรายการค้างส่ง |
| Scheduler | ผ่านบางส่วน | งาน publish/open/refresh/reminder/close ที่ถึงเวลาแล้วสำเร็จและไม่มี stale running job |

## รายการที่ยังต้อง UAT

1. **Stock end-to-end**
   - Import ยอดตั้งต้นจากข้อมูลจริง
   - เพิ่ม/หักด้วย CSV
   - ขอเบิก, จ่ายบางส่วน, จ่ายครบ
   - ส่งของเข้าแก๊ง, อนุมัติ, ปฏิเสธ
   - ย้อน batch และตรวจ negative-stock guard

2. **เงินรายสัปดาห์เมื่อหมดรอบ**
   - งาน `WEEKLY_CONVERT` มีกำหนดทำงานวันที่ 3 กันยายน 2569 เวลา 00:00 น. ตามเวลาไทย
   - ต้องตรวจว่ารายการค้างถูกแปลงเป็น Fine และ Public message/Audit ถูกอัปเดตครบ

3. **กิจกรรมที่ยังรอเวลา**
   - Activity reminder วันที่ 17 กันยายน 2569 เวลา 16:00 น.
   - Activity close วันที่ 18 กันยายน 2569 เวลา 16:00 น.
   - ยังไม่มีหลักฐาน UAT สำหรับกิจกรรมแบบประกาศอย่างเดียว

4. **Attendance edge cases**
   - ผลลาและลาเหตุฉุกเฉินในรอบเช็กชื่อ
   - การแก้ผลย้อนหลังพร้อมเหตุผลและ Audit

5. **Member/Fine edge cases**
   - ปฏิเสธคำขอสมาชิก, เพิ่มสมาชิกโดยตรง และให้ออกจากแก๊ง
   - ปฏิเสธหลักฐานค่าปรับ, ทบยอดหลังปฏิเสธ และยกเลิกค่าปรับ

## ข้อสังเกตด้าน Configuration

- `weeklyDuesChannelId` และ `weeklyDuesLogChannelId` ชี้ไป Channel เดียวกันในปัจจุบัน ระบบทำงานได้ แต่หลักฐานชำระจะไม่ถูกแยกออกจากประกาศรอบตามโครงสร้างที่ README แนะนำ
- Failed `MEMBER_ADMIN_ROLE_SYNC` 3 รายการเป็นประวัติก่อนแก้ Role hierarchy วันที่ 27 สิงหาคม 2569 งาน Role sync ล่าสุดหลังแก้ไขสำเร็จแล้ว ไม่ใช่ failure ปัจจุบัน

## Quality Gate

- TypeScript typecheck: ผ่าน
- ESLint: ผ่าน
- Unit/component tests: 95 ผ่าน, 53 integration tests ถูก skip เพราะไม่ได้กำหนด `TEST_DATABASE_URL`, ไม่มี failure
- Production build: ผ่าน
- Runtime dependency audit: 0 vulnerabilities
- Runtime log หลัง restart: ไม่พบ error ระดับ warn/error/fatal
