-- ═══════════════════════════════════════════════════════════════
-- 2026-10-17 (รอบสาม) — รหัสผ้า/ล็อต/ม้วน แบบสั้น
--   รหัสผ้า  SP02-F002          → S02F002
--   Lot      SP02-F002-L01      → S02F002-L01
--   รหัสม้วน SP02-F002-L01-R01  → S02F002-L01-1
-- ม้วนเก่าที่ใช้รหัสแบบเดิม (SR001-01, CT001-01 ...) เปลี่ยนเป็นแบบใหม่ด้วย
-- ═══════════════════════════════════════════════════════════════

UPDATE fabrics
   SET fabric_code = CONCAT('S', LPAD(supplier_id, 2, '0'), 'F', SUBSTRING_INDEX(fabric_code, '-F', -1))
 WHERE fabric_code LIKE 'SP%-F%';

UPDATE fabric_rolls fr
  JOIN fabrics f ON f.fabric_id = fr.fabric_id
   SET fr.lot_number = CONCAT(f.fabric_code, '-L', LPAD(fr.lot_no, 2, '0')),
       fr.roll_code  = CONCAT(f.fabric_code, '-L', LPAD(fr.lot_no, 2, '0'), '-', fr.roll_no)
 WHERE f.fabric_code IS NOT NULL
   AND fr.lot_no IS NOT NULL
   AND fr.roll_no IS NOT NULL;
