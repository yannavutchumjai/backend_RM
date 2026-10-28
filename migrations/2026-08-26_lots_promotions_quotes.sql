-- ═══════════════════════════════════════════════════════════════
-- 2026-08-26
-- 1) สินค้า: ล็อตของสินค้าที่เหมือนกันเป๊ะแต่ราคาขายไม่เท่ากัน (1_001, 1_002)
-- 2) ไซส์สินค้า: ตารางไว้ทำ dropdown ไซส์ เพิ่มไซส์ใหม่ได้จากหน้าเว็บ
-- 3) โปรโมชั่น: ช่วงเวลาที่ใช้ได้ + จำนวนสิทธิ์
-- 4) ตั้งราคาขาย: แยกราคาที่ "เก็บไว้เผื่ออนาคต" ออกจากงานที่ทำจริง
-- ═══════════════════════════════════════════════════════════════

-- 1) ล็อตสินค้า -------------------------------------------------
ALTER TABLE products
  ADD COLUMN group_no INT NULL AFTER id,
  ADD COLUMN lot_no INT NOT NULL DEFAULT 1 AFTER group_no,
  ADD COLUMN lot_code VARCHAR(20) NULL AFTER lot_no,
  ADD INDEX idx_products_group (group_no);

-- 2) ไซส์สินค้า -------------------------------------------------
CREATE TABLE IF NOT EXISTS product_sizes (
  size_id    INT AUTO_INCREMENT PRIMARY KEY,
  size_name  VARCHAR(50) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO product_sizes (size_name, sort_order) VALUES
  ('S', 10), ('M', 20), ('L', 30), ('XL', 40), ('XXL', 50), ('Free Size', 60);

-- ไซส์ที่มีอยู่แล้วในสินค้า ต้องอยู่ใน dropdown ด้วย
INSERT IGNORE INTO product_sizes (size_name, sort_order)
  SELECT DISTINCT TRIM(size), 100 FROM products
   WHERE size IS NOT NULL AND TRIM(size) <> '' AND deleted_at IS NULL;

-- 3) โปรโมชั่น: เวลา + สิทธิ์ ------------------------------------
-- usage_limit NULL = ไม่จำกัดสิทธิ์, start_at/end_at NULL = ไม่จำกัดเวลา
ALTER TABLE Promotion
  ADD COLUMN start_at    DATETIME NULL AFTER PER_ITEM,
  ADD COLUMN end_at      DATETIME NULL AFTER start_at,
  ADD COLUMN usage_limit INT      NULL AFTER end_at;

-- 4) ตั้งราคาขาย: ราคาที่เก็บไว้เผื่อ (ไม่ตัดผ้า) + สินค้าที่สร้างจากงานนี้
ALTER TABLE fabric_calc_sessions
  ADD COLUMN is_quote  TINYINT(1) NOT NULL DEFAULT 0 AFTER is_feasible,
  ADD COLUMN product_id INT       NULL          AFTER is_quote;
