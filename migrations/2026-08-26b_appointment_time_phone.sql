-- ═══════════════════════════════════════════════════════════════
-- 2026-08-26 (รอบสอง)
-- 1) วันนัดหมาย: เพิ่ม "เวลานัด"
-- 2) เบอร์โทร: บังคับ 10 หลัก — ล้างขีด/ช่องว่างของเดิม แล้วบีบชนิดคอลัมน์
-- 3) ไซส์สินค้า: ขยายความยาว เพราะกรณีตัดตามตัวจะเก็บขนาดตัวลูกค้าเป็นไซส์
-- ═══════════════════════════════════════════════════════════════

-- 1) เวลานัดหมาย ------------------------------------------------
-- NULL = นัดไว้แต่ยังไม่ระบุเวลา (ข้อมูลเก่าทั้งหมดเป็นแบบนี้)
ALTER TABLE tailoring_order_appointments
  ADD COLUMN appointment_time TIME NULL AFTER appointment_date;

-- 2) เบอร์โทร ----------------------------------------------------
-- ตัดทุกอย่างที่ไม่ใช่ตัวเลขออกก่อน (ของเดิมเก็บเป็น 081-555-1234)
UPDATE Bill
   SET customer_phone = LEFT(REGEXP_REPLACE(customer_phone, '[^0-9]', ''), 10)
 WHERE customer_phone IS NOT NULL AND customer_phone <> '';

UPDATE tailoring_orders
   SET customer_phone = LEFT(REGEXP_REPLACE(customer_phone, '[^0-9]', ''), 10)
 WHERE customer_phone IS NOT NULL AND customer_phone <> '';

UPDATE users
   SET phone = LEFT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10)
 WHERE phone IS NOT NULL AND phone <> '';

UPDATE suppliers
   SET phone = LEFT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10)
 WHERE phone IS NOT NULL AND phone <> '';

-- คอลัมน์ยาวได้ไม่เกิน 10 หลัก เก็บเกินไม่ได้อีก
ALTER TABLE Bill             MODIFY customer_phone VARCHAR(10) NULL;
ALTER TABLE tailoring_orders MODIFY customer_phone VARCHAR(10) NULL;

-- ต้องเป็นตัวเลข 10 หลักเท่านั้น (ว่าง/NULL = ไม่ระบุ ยังได้อยู่)
ALTER TABLE Bill
  ADD CONSTRAINT chk_bill_phone_10
  CHECK (customer_phone IS NULL OR customer_phone = '' OR customer_phone REGEXP '^[0-9]{10}$');

ALTER TABLE tailoring_orders
  ADD CONSTRAINT chk_tailoring_phone_10
  CHECK (customer_phone IS NULL OR customer_phone = '' OR customer_phone REGEXP '^[0-9]{10}$');

ALTER TABLE suppliers
  ADD CONSTRAINT chk_supplier_phone_10
  CHECK (phone IS NULL OR phone = '' OR phone REGEXP '^[0-9]{10}$');

-- 3) ไซส์สินค้า: รองรับข้อความขนาดตัวลูกค้า เช่น "อก 92 · เอว 76 · ยาว 60"
ALTER TABLE products MODIFY size VARCHAR(120) NULL;
