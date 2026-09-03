# Implementation Status

อัปเดต: 2026-08-27

## พร้อมใช้งานใน Discord

- Guild bootstrap และ slash command registration
- Configurable role mapping
- Configurable channel mapping
- Admin Control Panel หนึ่ง Channel
- Self-registration
- Per-request Admin registration card พร้อมปุ่มอนุมัติ/ปฏิเสธและ durable publish/update
- Registration eligibility guard ก่อนเปิด Modal พร้อม database conflict guard เมื่อส่งซ้ำ
- Pending member list
- Approve/reject member
- Direct-add member
- Mark member as former while preserving history
- Durable Discord role synchronization with retry and stale-lock recovery
- Public active-member roster พร้อม pagination และ durable refresh เมื่ออนุมัติ เพิ่มตรง หรือให้ออกจากแก๊ง
- Roster title workflow: หัวแก๊ง 1 คน, รองแก๊งหลายคน, บัญชีแก๊ง 1 คน, สำรองหลายคน และสมาชิกทั่วไป โดยเลือกจากสมาชิก ACTIVE แบบแบ่งหน้า
- หัวแก๊ง/รองแก๊งซิงก์ Discord Role ผ่าน durable job; บัญชีแก๊งและสำรองไม่มี Role/authorization พิเศษ และตำแหน่งถูกถอดเมื่อเป็นอดีตสมาชิก
- จำกัดการแต่งตั้งตำแหน่งไว้ที่ Head/Dev เพื่อป้องกัน Deputy ยกระดับสิทธิ์
- Fight position workflow สำหรับ Dev/Head/Deputy: สร้างได้สูงสุด 10 Set, เลือก Set ที่ใช้งาน และมอบตำแหน่งให้สมาชิก ACTIVE แยกกันในแต่ละ Set
- Public Fight summary แสดงทุก Set พร้อมสมาชิก ACTIVE ทั้งหมด รวมผู้ที่ยังไม่กำหนดตำแหน่ง และ durable refresh เมื่อข้อมูลเปลี่ยน
- HTTP health check
- Activity Admin panel รองรับกิจกรรมสะสมคะแนน ส่งผลงานไม่มีคะแนน และประกาศอย่างเดียว
- Activity score item เพิ่ม แก้คะแนน และปิดใช้งาน
- Components v2 submission Modal พร้อมอัปโหลดรูป 1–5 รูป
- Participant เพิ่ม/ลบได้หลายรอบ, เปลี่ยน Loop และยกเลิกรายการ
- Public activity log พร้อมตรวจสิทธิ์ผู้ส่ง/Admin ฝั่ง server
- Top 20 leaderboard แบบอันดับร่วมและ dynamic score recalculation
- Durable publish/open/one-day reminder/close/final-summary jobs
- Shared date/time input parser สำหรับ Activity, Attendance/Recurring, Leave/Edit, Fine และ Weekly Dues โดยกรอกวัน/เวลาใน Modal เดียวตามรูปแบบที่กำหนด
- Attendance Admin panel รองรับ Manual และ Auto แยก `AIRDROP`/`GENERAL` พร้อมหลาย Auto entry ต่อวัน
- Durable attendance publish/open/15-minute reminder/close/refresh jobs
- Airdrop ใช้ event time กับช่วงรับรูปก่อน/หลัง รองรับข้ามเที่ยงคืน และบังคับรูป PNG/JPEG/WebP 1 รูปไม่เกิน 10 MB
- Active member check-in พร้อม public live list, timestamp, ลิงก์หลักฐาน และ SHA-256 duplicate guard ข้ามรอบ
- Leave panel และ public leave log ใช้ Channel แยกกัน โดยเจ้าของ/Admin แก้หรือยกเลิกได้
- Final classification: present, leave, emergency leave และ absent
- Admin correction หลังปิดรอบ พร้อม correction reason และ Audit log
- Fine Admin panel และ Components v2 Modal สร้างค่าปรับ
- Public fine announcement พร้อมยอดปัจจุบัน กำหนดชำระ และปุ่มส่งหลักฐาน
- หลักฐานรูป 1 รูป, full-payment validation และ approval workflow ใน Channel Log ค่าปรับ โดย Channel ค่าปรับเก็บเฉพาะประกาศรายการและสถานะรอตรวจ/ชำระแล้ว; เมื่ออนุมัติจึงสร้างรายรับใน Log การเงินรวม
- Deputy/Head/Dev อนุมัติหรือปฏิเสธหลักฐานได้
- 24-hour surcharge accrual พร้อม catch-up หลังปฏิเสธหลักฐาน
- Treasury income entry แบบ idempotent เมื่ออนุมัติการชำระ
- Fine cancellation จำกัด Head/Dev พร้อม Audit reason
- Treasury Admin panel สำหรับยอดตั้งต้น รายรับ รายจ่าย และ reversal
- Public treasury balance panel พร้อมรายการล่าสุด
- Public ledger log พร้อมรูปหลักฐานรายรับ/รายจ่าย 1 รูป
- Serialized per-guild balance calculation และ immutable balance-after snapshot
- Negative-balance guard สำหรับรายจ่ายและ reversal
- คำขอเบิกเงินแก๊งแยก Channel พร้อม approve/reject/cancel และหัก Treasury แบบ atomic โดยไม่ต้องแนบหลักฐาน
- Head/Dev-only opening balance และ reversal พร้อม Audit log
- Fine payment evidence ถูก re-upload เข้า Treasury log อัตโนมัติ
- Weekly dues Admin panel และ Components v2 Modal สร้างรอบเรียกเก็บ
- Snapshot สมาชิกสถานะใช้งานทุกคน รวม Dev/หัวแก๊ง/รองแก๊งที่ยังเป็นสมาชิก
- ยอดมาตรฐานต่อรอบและ override ยอดเฉพาะสมาชิกรายคน
- Public weekly status list พร้อมปุ่มส่งหลักฐานรูป 1 รูป โดยหลักฐานรอตรวจไปยัง Channel Log ส่งเงินรายสัปดาห์ และเมื่ออนุมัติจึงสร้างรายรับใน Log การเงินรวม
- Deputy/Head/Dev อนุมัติหรือปฏิเสธหลักฐาน โดยยอดเข้า Treasury อัตโนมัติ
- ปิดรอบอัตโนมัติและแปลงยอดค้างเป็น Fine พร้อมค่าปรับครั้งแรก
- ค่าปรับรายสัปดาห์เริ่มทบครั้งแรกหลังปิดรอบ 24 ชั่วโมง แล้วทบทุก 24 ชั่วโมง
- หลักฐานรอตรวจไม่ถูกแปลงซ้ำ และหากปฏิเสธหลังหมดเวลาจะสร้าง Fine ทันที
- Stock Admin panel สำหรับ Import ยอดตั้งต้นและเพิ่ม/หักด้วย CSV
- Item code ถูกสร้างอัตโนมัติจากยอดตั้งต้น และ public stock รองรับ pagination
- ตรวจ exact CSV header, duplicate hash/batch, stale expected quantity และ negative stock
- Serialized per-guild inventory transaction ป้องกัน CSV/เบิก/Deposit/ย้อนรายการชนกัน
- Public stock batch log พร้อมเก็บไฟล์ CSV ต้นฉบับเป็นหลักฐาน
- สมาชิกสถานะใช้งานเลือกของจาก Stock ใส่ตะกร้าแบบแบ่งหน้าได้สูงสุด 25 รายการต่อคำขอ โดยไม่ต้องจำหรือพิมพ์ `item_code`
- Deputy/Head/Dev จ่ายของได้หลายรอบและจ่ายบางส่วนได้ โดยบังคับเหตุผลเมื่อยังไม่ครบ
- Public withdrawal log แสดงผู้ขอ รายการ จำนวนที่จ่าย และ Admin ผู้จ่าย
- สมาชิกสถานะใช้งานเลือกของจาก Stock ใส่ตะกร้าแบบแบ่งหน้าได้สูงสุด 25 รายการต่อคำขอ โดยไม่ต้องจำหรือพิมพ์ชื่อ พร้อมจำนวนและที่มา
- บังคับรูปหลักฐาน Deposit 1 รูปไม่เกิน 10 MB และ re-upload เก็บใน public Stock log
- ทุกคนเห็น Deposit log และปุ่มตรวจรายการ แต่ server อนุญาตเฉพาะ Deputy/Head/Dev
- Stock dashboard, withdrawal log และ deposit log ใช้ Channel configuration แยกกัน
- การอนุมัติเพิ่ม Stock ทั้งคำขอแบบ atomic พร้อมสร้าง DEPOSIT batch/movement และ refresh dashboard
- การปฏิเสธบังคับเหตุผลและไม่เปลี่ยน Stock; การ approve retry/concurrent ไม่เพิ่มยอดซ้ำ
- Head/Dev ย้อน batch เพิ่ม/หัก CSV ได้ พร้อมเหตุผลและ negative-stock guard
- Durable Admin Audit log พร้อมแสดงผู้ดำเนินการ action, entity, เหตุผล และ field ที่เปลี่ยน โดยไม่แสดงค่าข้อมูลอ่อนไหว
- Audit publish ใช้ outbox job ใน transaction เดียวกับการเขียน Audit และ backfill รายการเดิมที่ยังไม่เคยส่ง
- Scheduler ประมวลผลเฉพาะ Guild ของ runtime เพื่อไม่ให้ test/tenant อื่นรบกวน production queue

## พร้อมในฐานข้อมูลและกฎธุรกิจ แต่ Discord workflow ยังไม่เปิด

ไม่มีในขณะนี้

## Verification ล่าสุด

- ESLint: pass
- TypeScript typecheck: pass
- Production build: pass
- Tests ล่าสุด: 180 pass, 0 skipped โดยใช้ PostgreSQL local แยกสำหรับ integration
- Member PostgreSQL integration tests: 5 pass
- Activity PostgreSQL integration tests: 7 pass
- Attendance PostgreSQL integration tests: 8 pass
- Fine PostgreSQL integration tests: 6 pass
- Treasury PostgreSQL integration tests: 6 pass
- Weekly dues PostgreSQL integration tests: 4 pass
- Inventory PostgreSQL integration tests: 4 pass
- Withdrawal PostgreSQL integration tests: 4 pass
- Deposit PostgreSQL integration tests: 4 pass
- Covered business-rule statements: 96.52%
- PostgreSQL 17 migrations: applied successfully และทดสอบ integration ผ่าน
- Legacy weekly migration: backfill request ID และเวลาปิดรอบตาม timezone ผ่าน
- Legacy withdrawal migration: backfill idempotency request ID ผ่าน
- Legacy deposit migration: backfill idempotency request ID ผ่าน
- Runtime dependency audit: 0 vulnerabilities (`npm audit --omit=dev`)

ยังไม่ได้ทดสอบ Discord UAT หรือ Quaxly runtime เพราะต้องใช้ Bot token, Server ID และ production-like PostgreSQL ของผู้ดูแลระบบ
