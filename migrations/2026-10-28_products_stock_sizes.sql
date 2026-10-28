-- ═══════════════════════════════════════════════════════════════
-- สินค้า + จำนวนคงเหลือ + ช่วงขนาดชุด + หน้าคำนวณผ้าแบบกรอกเมตรเอง
-- (มาจาก backend_RM/sql/2026-10-19_products_rework.sql — เอาเฉพาะส่วนที่ "เพิ่ม" ไม่ลบตาราง/คอลัมน์เดิม)
-- รันซ้ำได้ (MariaDB / XAMPP)
--
-- คงเหลือ = ชุดที่ตัด (fabric_calc_sessions.qty) + stock_adjust − ที่ขายไปแล้ว
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS source ENUM('made','resale') NOT NULL DEFAULT 'resale' AFTER status,
  ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255) DEFAULT NULL AFTER source,
  ADD COLUMN IF NOT EXISTS stock_adjust INT NOT NULL DEFAULT 0 AFTER supplier_name;

-- สินค้าที่เกิดจากการตัด (มีรอบตัดผูกอยู่) = ร้านตัดเอง
UPDATE products p
   SET p.source = 'made'
 WHERE EXISTS (SELECT 1 FROM fabric_calc_sessions s WHERE s.product_id = p.id);

-- ผูก category_id จากชื่อหมวดเดิม (products.category) — คอลัมน์ category ยังเก็บไว้
UPDATE products p
  JOIN product_category pc ON pc.category_name = TRIM(p.category) AND pc.deleted_at IS NULL
   SET p.category_id = pc.category_id
 WHERE p.category_id IS NULL;

-- สินค้ารับมาขายเดิมที่ยังไม่เคยมีจำนวน → ตั้งให้เหลือ 1 ชิ้น (= 1 + ที่ขายไปแล้ว)
-- แก้จำนวนจริงได้ที่หน้าสินค้า
UPDATE products p
   SET p.stock_adjust = 1 + (
         SELECT COALESCE(SUM(d.quantity), 0)
           FROM Detail_bill d
           JOIN Bill b ON b.idBill = d.Bill_idBill AND b.deleted_at IS NULL
          WHERE d.Products_idProducts = p.id AND d.deleted_at IS NULL
       )
 WHERE p.source = 'resale' AND p.stock_adjust = 0 AND p.deleted_at IS NULL;

-- ช่วงขนาดของชุด (1 แถว = 1 จุดวัด) กรอกตอนกด "ตัดเสร็จ"
CREATE TABLE IF NOT EXISTS product_size_ranges (
  range_id    INT(11)      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id  INT(11)      NOT NULL,
  field_key   VARCHAR(50)  DEFAULT NULL,
  field_label VARCHAR(100) NOT NULL,
  min_cm      DECIMAL(5,1) DEFAULT NULL,
  max_cm      DECIMAL(5,1) DEFAULT NULL,
  sort_order  INT(11)      NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_psr_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- หน้าคำนวณผ้าใหม่ไม่ส่งตัวเลขแบบเก่าแล้ว → ให้คอลัมน์เดิมว่างได้ (ข้อมูลเก่ายังอยู่ครบ)
ALTER TABLE fabric_calc_sessions
  MODIFY size_label VARCHAR(20) NULL DEFAULT NULL;

ALTER TABLE fabric_calc_items
  MODIFY usage_per_piece  DECIMAL(8,2) NULL DEFAULT NULL,
  MODIFY qty              INT(11)      NULL DEFAULT NULL,
  MODIFY before_remaining DECIMAL(8,2) NULL DEFAULT NULL,
  MODIFY after_remaining  DECIMAL(8,2) NULL DEFAULT NULL;
