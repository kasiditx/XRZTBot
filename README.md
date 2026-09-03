# MiruBot

Discord bot สำหรับบริหารจัดการแก๊ง โดยใช้ Discord เป็นหน้าจอหลักและ PostgreSQL เป็นแหล่งข้อมูลจริง ไม่มีการเชื่อมต่อ FiveM

## สถานะปัจจุบัน

Foundation, Member, Activity, Attendance/Leave, Fine, Treasury, Weekly Dues และ Stock/Withdrawal/Deposit vertical slice พร้อมสำหรับ Discord UAT:

- ตั้งค่า Role: Dev, หัวแก๊ง, รองแก๊ง, สมาชิก และอดีตสมาชิก/พี่น้อง
- ตั้งค่า Channel ทุกประเภทด้วย Discord ID โดยไม่ผูกกับชื่อ Channel
- Control Panel เดียวใน Channel ของ Admin
- สมาชิกลงทะเบียนเองด้วย Modal และรอ Admin อนุมัติ
- คำขอลงทะเบียนแต่ละรายการถูกส่งไปยัง Channel Admin พร้อมปุ่มอนุมัติ/ปฏิเสธโดยตรง
- Bot ป้องกันสมาชิกสถานะรอตรวจสอบหรือใช้งานกดเปิดแบบฟอร์มและส่งคำขอซ้ำ
- Admin อนุมัติ ปฏิเสธ เพิ่มสมาชิกโดยตรง และให้ออกจากแก๊ง
- เปลี่ยน Role สมาชิก/อดีตสมาชิกผ่าน durable job พร้อม retry
- รายชื่อสมาชิกสถานะใช้งานแบบ public แบ่งหน้าละ 25 คน และอัปเดตอัตโนมัติเมื่อสถานะสมาชิกเปลี่ยน
- Dev/หัวแก๊งกำหนดตำแหน่งในรายชื่อเป็นหัวแก๊ง รองแก๊ง บัญชีแก๊ง สำรอง หรือสมาชิกทั่วไปได้ โดยเลือกจากสมาชิก ACTIVE เท่านั้น
- ตำแหน่งหัวแก๊ง/รองแก๊งซิงก์ Discord Role อัตโนมัติ; บัญชีแก๊งและสำรองเป็นป้ายแสดงผลโดยไม่มี Role/สิทธิ์พิเศษ
- รายชื่อเรียงหัวแก๊ง รองแก๊ง บัญชีแก๊ง สำรอง แล้วจึงสมาชิกทั่วไป; หัวแก๊งและบัญชีแก๊งมีได้อย่างละหนึ่งคน ส่วนรองแก๊งและสำรองมีได้หลายคน
- Dev/หัวแก๊ง/รองแก๊งสร้าง Fight Set ได้สูงสุด 10 Set, เลือก Set ที่ใช้งาน และจัดสมาชิก ACTIVE คนละหนึ่งตำแหน่งต่อ Set
- สรุปตำแหน่ง Fight แสดงทุก Set พร้อมสมาชิก ACTIVE และสถานะ `ยังไม่กำหนดตำแหน่ง` โดยอัปเดตข้อความเดิมอัตโนมัติ
- Admin สร้างกิจกรรมได้ 3 รูปแบบ: สะสมคะแนน, ส่งผลงานไม่มีคะแนน และประกาศอย่างเดียว
- สมาชิกส่งกิจกรรมแบบคะแนน/ส่งผลงานผ่าน Modal พร้อมรูป 1–5 รูปและเลือกผู้ร่วม ส่วนกิจกรรมประกาศไม่มีปุ่ม Submission
- ผู้ส่งและ Admin ยกเลิก แก้ผู้ร่วม และเปลี่ยน Loop จากปุ่มใต้ Log ได้
- Leaderboard 20 อันดับ รองรับอันดับร่วม และคำนวณย้อนหลังเมื่อแก้คะแนน
- กิจกรรมส่งผลงานสรุปจำนวน Submission และจำนวนรายการของผู้ร่วมโดยไม่สร้างคะแนน 0 หลอก ๆ
- Durable job สำหรับประกาศ เปิด เตือนก่อนปิด 1 วัน ปิด และส่งสรุปอัตโนมัติ
- ช่องวันที่และเวลาของกิจกรรม เช็กชื่อ/ตารางประจำ แจ้งลา ค่าปรับ และเงินรายสัปดาห์กรอกใน Modal เดียว โดยรองรับรูปแบบที่ระบุในแต่ละช่อง
- ทุกระบบที่รับรูปหลักฐานให้เลือกส่งแบบแนบไฟล์ หรือวาง Discord Media Link; Bot ดาวน์โหลดและ re-upload รูปเข้า Log ทันทีเพื่อไม่พึ่งลิงก์ที่อาจหมดอายุ (Stock CSV ยังคงรับเป็นไฟล์เท่านั้น)
- หัวแก๊ง/รองแก๊งเปิดเช็กชื่อ Manual หรือตั้ง Auto แยกเป็น `AIRDROP` และ `GENERAL` ได้หลายรายการในวันเดียว ระบบเปิด เตือนก่อนปิด 15 นาที และปิดอัตโนมัติ
- Auto แบบ `AIRDROP` ตั้งเวลาเหตุการณ์พร้อมช่วงเปิดก่อน/ปิดหลัง (ค่าเริ่มต้น 10 นาที) และรองรับรอบข้ามเที่ยงคืน เช่น 23:50–00:10
- สมาชิกที่มี Role และสถานะใช้งานกดเช็กชื่อทั่วไปได้ ส่วน Airdrop ต้องแนบรูป 1 รูปที่เห็นตัวละครของตัวเองและรายชื่อในวอภายในช่วงเปิด
- รูป Airdrop ถูกเก็บใน Channel เช็กชื่อ มีลิงก์จากรายชื่อ และตรวจ SHA-256 เพื่อห้ามใช้ไฟล์เดิมซ้ำข้ามรอบ; เนื้อหาในรูปยังต้องอาศัย Admin ตรวจและแก้ผลย้อนหลังเมื่อไม่ตรงกติกา
- สมาชิกแจ้งลาได้ทันทีโดยไม่รออนุมัติ แก้/ยกเลิกได้ และทุกคนเห็นใบลาใน Channel Log แจ้งลาที่แยกจาก Panel
- สรุปผล `มา`, `ลา`, `ลาเหตุฉุกเฉิน`, `ขาด` ตามเวลาจริง และ Admin แก้ย้อนหลังพร้อม Audit log
- Admin สร้างค่าปรับพร้อมกำหนดวันครบกำหนดและยอดเพิ่มทุก 24 ชั่วโมง
- สมาชิกส่งรูปหลักฐาน 1 รูปและต้องชำระเต็มจำนวน โดย Channel ค่าปรับแสดงเฉพาะรายการที่ถูกแจ้ง ส่วนหลักฐานรอตรวจและผลอนุมัติแสดงใน Channel Log ค่าปรับ
- รองแก๊ง หัวแก๊ง และ Dev อนุมัติ/ปฏิเสธหลักฐานได้ โดยยอดหยุดทบระหว่างรอตรวจ
- เมื่ออนุมัติ Bot เพิ่มรายรับเข้า Treasury ledger อัตโนมัติและป้องกันการบันทึกซ้ำ
- การยกเลิกค่าปรับจำกัดเฉพาะหัวแก๊ง/Dev และบังคับเหตุผลใน Audit log
- Head/Dev ตั้งยอดเงินกองกลางเริ่มต้นได้หนึ่งครั้งโดยไม่ต้องแนบรูป
- รองแก๊ง หัวแก๊ง และ Dev เพิ่มรายรับ/รายจ่ายพร้อมรูปหลักฐาน 1 รูป
- Channel เงินแก๊งเป็น Log การเงินรวมของรายการที่กระทบ Ledger แสดงรายรับ–รายจ่ายจากค่าปรับ เงินรายสัปดาห์ การเบิกเงิน และรายการ Manual พร้อมยอดคงเหลือล่าสุดที่ถูกย้ายมาไว้ท้าย Channel หลัง Ledger เปลี่ยน
- รายจ่ายและ reversal ถูก serialize ต่อ Server และถูกปฏิเสธหากทำให้ยอดติดลบ
- สมาชิกสถานะใช้งานส่งคำขอเบิกเงินได้; Dev/หัวแก๊ง/รองแก๊งอนุมัติหรือปฏิเสธได้โดยไม่ต้องแนบรูป
- เมื่ออนุมัติ Bot หักยอดเต็มจำนวนครั้งเดียวและเพิ่ม Expense ลง Ledger อัตโนมัติ; ถ้ายอดไม่พอจะไม่เปลี่ยนสถานะคำขอ
- การย้อนรายการจำกัด Head/Dev และไม่อนุญาตให้ย้อนรายรับค่าปรับจากหน้า Treasury เพื่อป้องกันสถานะขัดกัน
- รองแก๊ง หัวแก๊ง และ Dev สร้างรอบส่งเงินรายสัปดาห์ กำหนดช่วงวันที่ ยอดมาตรฐาน และค่าปรับได้
- ระบบ snapshot สมาชิกสถานะใช้งานทุกคนตอนสร้างรอบ รวม Admin ที่ยังมีสถานะสมาชิก และกำหนดยอดเฉพาะคนได้
- สมาชิกส่งเต็มจำนวนพร้อมรูป 1 รูป Channel ส่งเงินรายสัปดาห์แสดงเฉพาะรอบและปุ่มส่งหลักฐาน ส่วน Admin ตรวจหลักฐานจาก Channel Log ส่งเงินรายสัปดาห์
- เมื่ออนุมัติ ยอดจะเข้าเงินกองกลางอัตโนมัติ; เมื่อหมดเวลา ยอดค้างจะกลายเป็น Fine พร้อมค่าปรับครั้งแรก
- ค่าปรับทบของรอบรายสัปดาห์เริ่มหลังหมดเวลา 24 ชั่วโมง และเพิ่มต่อทุก 24 ชั่วโมงจนกว่าจะชำระ
- หลักฐานที่รอตรวจตอนปิดรอบจะไม่ถูกปรับ; หากถูกปฏิเสธหลังหมดเวลา ระบบสร้าง Fine ทันที
- Head/Dev Import ยอดตั้งต้น Stock จาก CSV ได้หนึ่งครั้งโดยไม่ต้องแนบรูป และ Bot สร้าง `MR-001...` ให้อัตโนมัติ
- รองแก๊ง หัวแก๊ง และ Dev เพิ่ม/หัก Stock ด้วย CSV พร้อม `expected_quantity` เพื่อป้องกันยอดเก่าทับข้อมูลใหม่
- ทุกคนเห็น Stock คงเหลือครบทุกชนิดผ่าน public dashboard แบบแบ่งหน้า
- สมาชิกสถานะใช้งานขอเบิกหลายชนิดในคำขอเดียวด้วยรูปแบบ `MR-001=จำนวน`
- Admin จ่ายของได้หลายรอบและจ่ายบางส่วนได้ โดย public log เก็บผู้จ่ายและเหตุผลที่ยังจ่ายไม่ครบ
- สมาชิกสถานะใช้งานเลือกสิ่งของจาก Stock ใส่ตะกร้าได้สูงสุด 25 รายการโดยไม่ต้องจำชื่อหรือรหัส จากนั้นกรอกจำนวน/ที่มา และแนบรูปหลักฐาน 1 รูป
- ทุกคนเห็น Deposit log; ปุ่มอนุมัติ/ปฏิเสธแสดงต่อทุกคนแต่ตรวจสิทธิ์ Deputy/Head/Dev ฝั่ง server
- Stock dashboard, Log เบิกของ และ Log ส่งของกำหนดเป็นคนละ Channel ได้
- เมื่ออนุมัติ Bot เพิ่ม Stock ทุกชิ้นใน transaction เดียวและเก็บ batch/movement; เมื่อปฏิเสธ Stock ไม่เปลี่ยน
- Head/Dev ย้อน batch CSV ที่ลงผิดได้ โดยระบบป้องกันการย้อนหากทำให้ Stock ติดลบ
- Admin Audit log ถูกส่งไปยัง Channel Audit แบบ durable โดยไม่ mention ผู้ดำเนินการ และ migration จะนำ Audit เดิมที่ยังไม่เคยส่งมา publish ให้ครบ
- PostgreSQL schema ครอบคลุมกิจกรรม เช็กชื่อ/ลา ค่าปรับ เงินกองกลาง ส่งเงินรายสัปดาห์ stock เบิกของ ส่งของ และตำแหน่ง fight
- กฎธุรกิจหลักมี unit test: permission, leaderboard, attendance, fine accrual, treasury, weekly overdue, stock CSV และ Deposit proof

ระบบกิจกรรม เช็กชื่อ/ลา ค่าปรับ เงินกองกลาง เงินรายสัปดาห์ Stock/เบิกของ/ส่งของ และตำแหน่ง Fight เปิดปุ่มแล้ว แต่ยังต้องทดสอบ UAT กับ Discord Server จริงก่อน production

## Technology

- Node.js 22+
- TypeScript (ESM)
- discord.js
- PostgreSQL + Drizzle ORM
- Jest + ESLint

## Discord setup

1. สร้าง Application และ Bot ใน Discord Developer Portal
2. เปิด `Server Members Intent`
3. เชิญ Bot ด้วย scope `bot` และ `applications.commands`
4. ให้ permission อย่างน้อย `Manage Roles`, `View Channels`, `Send Messages`, `Embed Links`, `Attach Files` และ `Read Message History`
5. วาง Role ของ MiruBot ไว้สูงกว่า Role หัวแก๊ง รองแก๊ง สมาชิก และอดีตสมาชิก ไม่เช่นนั้น Discord จะไม่อนุญาตให้ Bot เปลี่ยน Role
6. ห้าม commit Bot token ลง Git; เก็บใน Quaxly Environment Variables เท่านั้น

## Local setup

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

Environment variables:

| Variable | Required | Description |
|---|---:|---|
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_APPLICATION_ID` | yes | Application ID |
| `DISCORD_GUILD_ID` | yes | Server ID สำหรับ MVP server เดียว |
| `DATABASE_URL` | yes | External PostgreSQL connection URL สำหรับ runtime |
| `DATABASE_URL_UNPOOLED` | no | Direct PostgreSQL URL สำหรับ migration; ถ้าไม่ตั้งจะใช้ `DATABASE_URL` |
| `TIMEZONE` | no | ค่าเริ่มต้น `Asia/Bangkok` |
| `LOG_LEVEL` | no | ค่าเริ่มต้น `info` |
| `SCHEDULER_POLL_MS` | no | ค่าเริ่มต้น `5000`, ต่ำสุด `1000` |
| `HEALTH_PORT` | no | ค่าเริ่มต้น `3000` |

## First-time Discord commands

1. Server Owner หรือผู้มี Discord Administrator ใช้ `/mirubot setup-roles`
2. Dev หรือหัวแก๊งใช้ `/mirubot set-channel` กำหนด Channel ทีละประเภท โดยแยก Channel ใช้งานออกจาก `Log ส่งเงินรายสัปดาห์`, `Log เบิกเงินแก๊ง` และ `Log ค่าปรับ`; เมื่อรายการได้รับอนุมัติ รายรับ–รายจ่ายจะถูกบันทึกซ้ำใน `Log การเงินรวม (เงินแก๊ง)` พร้อมยอดคงเหลือล่าสุด
3. ใช้ `/mirubot panel` ใน Control Channel
4. ใช้ `/mirubot publish-registration` เพื่อส่งปุ่มลงทะเบียนไปยัง Channel ลงทะเบียนสมาชิก
5. ใช้ `/mirubot publish-member-roster` เพื่อสร้างรายชื่อสมาชิกปัจจุบันแบบอัปเดตค้างไว้
6. ใน Control Panel กด `เช็กชื่อ/ลา` แล้วกด `ส่ง Panel แจ้งลา` หนึ่งครั้ง

ชื่อ Role และ Channel ตั้งเองได้ทั้งหมด Bot บันทึกและตรวจด้วย Discord ID

## Quaxly deployment

ใช้ external PostgreSQL เพราะ container/runtime disk ไม่ควรถูกใช้เป็นฐานข้อมูลถาวร

- Build command: `npm ci && npm run build && npm run db:migrate`
- Start command: `npm start`
- Health path: `/health`
- ตั้ง Environment Variables ตาม `.env.example`

ก่อน deploy production ให้รัน migration กับฐานข้อมูลเป้าหมายจาก release เดียวกันเพียงครั้งเดียว และสำรองฐานข้อมูลก่อน migration ทุกครั้ง

## Quality commands

```bash
npm run lint
npm run typecheck
npm run test:coverage -- --runInBand
npm run build
```

`npm audit --omit=dev` ต้องไม่มีช่องโหว่ runtime ส่วน advisory ที่พบใน `drizzle-kit` ปัจจุบันอยู่ใน dev-only migration tooling และไม่ถูกติดตั้งเมื่อ deploy ด้วย production dependencies เท่านั้น

## Stock CSV

- ยอดตั้งต้น: [`docs/stock-opening-template.csv`](docs/stock-opening-template.csv)
- เพิ่ม/หัก stock: [`docs/stock-movement-template.csv`](docs/stock-movement-template.csv)

Header ต้องตรงและเรียงตาม template เท่านั้น ระบบตรวจ duplicate file hash, `batch_ref`, `expected_quantity`, item code/name และปฏิเสธทั้งไฟล์หากมีแม้แต่หนึ่งแถวผิด

ยอดตั้งต้นรองรับสูงสุด 1,000 รายการและสร้าง item code ตามลำดับแถว ส่วนไฟล์เพิ่ม/หักใช้ได้สูงสุด 1,000 movement ต่อ batch ไฟล์ CSV ที่ Bot re-upload ใน public log ถือเป็นหลักฐานของ batch จึงไม่ต้องแนบรูปเพิ่ม

สมาชิกส่งของเข้าแก๊งจาก public Stock panel โดยเลือกหลายรายการจาก Stock จริงผ่านตะกร้าแบบแบ่งหน้า สูงสุด 25 รายการต่อคำขอ ระบบเติมชื่อสินค้าให้และให้แก้เฉพาะจำนวน พร้อมระบุที่มาและรูปหลักฐาน 1 รูปไม่เกิน 10 MB เมื่อ Deputy/Head/Dev อนุมัติ ระบบจึงเพิ่มยอดเข้า Stock; รายการที่ยังรอตรวจหรือถูกปฏิเสธจะไม่เปลี่ยนยอด
