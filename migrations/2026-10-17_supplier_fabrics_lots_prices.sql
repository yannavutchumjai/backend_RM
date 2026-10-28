-- ═══════════════════════════════════════════════════════════════
-- 2026-10-17
-- 1) ผ้าผูกกับผู้จัดจำหน่าย (suppliers 1 ── M fabrics)
--    ผ้า 1 รายการ = ผู้จัดจำหน่าย + ประเภทผ้า + ลวดลาย + สี (ห้ามซ้ำ)
--    ชื่อผ้าจึงเป็นของแต่ละผู้จัดจำหน่าย และมีรหัสผ้า เช่น SP01-F003
-- 2) ม้วนผ้าเก็บเลขล็อตเป็นตัวเลข (lot_no) เพื่อออกรหัสอัตโนมัติ
--    รหัสล็อต  = <รหัสผ้า>-L<ลำดับล็อต>      เช่น SP01-F003-L02
--    รหัสม้วน  = <รหัสล็อต>-R<ลำดับม้วน>     เช่น SP01-F003-L02-R01
-- 3) ตารางราคาผ้าของแต่ละผู้จัดจำหน่าย (เผื่อฟังก์ชันเปรียบเทียบราคา)
--    + view ราคาล่าสุดของแต่ละร้าน แยกตาม ประเภท/ลวดลาย/สี
-- ═══════════════════════════════════════════════════════════════

-- 1) fabrics ─────────────────────────────────────────────────────
-- supplier_id เป็น NULL ได้เฉพาะผ้าเก่าที่ยังหาเจ้าของไม่ได้
ALTER TABLE fabrics
  ADD COLUMN supplier_id INT(11) NULL AFTER fabric_id,
  ADD COLUMN fabric_code VARCHAR(30) NULL AFTER supplier_id;

-- ผ้าเก่า: เอาผู้จัดจำหน่ายจากม้วนแรกของผ้านั้น
UPDATE fabrics f
  JOIN (
    SELECT fabric_id, supplier_id
      FROM (SELECT fabric_id, supplier_id,
                   ROW_NUMBER() OVER (PARTITION BY fabric_id ORDER BY roll_id) AS rn
              FROM fabric_rolls) x
     WHERE rn = 1
  ) r ON r.fabric_id = f.fabric_id
   SET f.supplier_id = r.supplier_id
 WHERE f.supplier_id IS NULL;

-- ผ้าเก่าที่ไม่มีม้วน: เอาจากใบสั่งซื้อแรก
UPDATE fabrics f
  JOIN (
    SELECT fabric_id, supplier_id
      FROM (SELECT poi.fabric_id, po.supplier_id,
                   ROW_NUMBER() OVER (PARTITION BY poi.fabric_id ORDER BY poi.item_id) AS rn
              FROM purchase_order_items poi
              JOIN purchase_orders po ON po.po_id = poi.po_id
             WHERE po.supplier_id IS NOT NULL) x
     WHERE rn = 1
  ) p ON p.fabric_id = f.fabric_id
   SET f.supplier_id = p.supplier_id
 WHERE f.supplier_id IS NULL;

-- รหัสผ้า: SP<รหัสร้าน 2 หลัก>-F<ลำดับผ้าในร้าน 3 หลัก>
UPDATE fabrics f
  JOIN (
    SELECT fabric_id,
           CONCAT('SP', LPAD(supplier_id, 2, '0'), '-F',
                  LPAD(ROW_NUMBER() OVER (PARTITION BY supplier_id ORDER BY fabric_id), 3, '0')) AS code
      FROM fabrics
     WHERE supplier_id IS NOT NULL
  ) c ON c.fabric_id = f.fabric_id
   SET f.fabric_code = c.code;

ALTER TABLE fabrics
  ADD UNIQUE KEY uq_fabrics_code (fabric_code),
  ADD UNIQUE KEY uq_fabrics_spec (supplier_id, type_id, category_id, color_id),
  ADD CONSTRAINT fk_fabrics_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (supplier_id);

-- 2) fabric_rolls ────────────────────────────────────────────────
-- lot_number / roll_code เดิมเก็บไว้ตามเดิม ไม่เขียนทับ
ALTER TABLE fabric_rolls
  ADD COLUMN lot_no INT(11) NULL AFTER lot_number,
  ADD COLUMN roll_no INT(11) NULL AFTER lot_no;

UPDATE fabric_rolls fr
  JOIN (
    SELECT roll_id,
           ROW_NUMBER() OVER (PARTITION BY fabric_id ORDER BY purchase_date, roll_id) AS lot_no
      FROM fabric_rolls
  ) x ON x.roll_id = fr.roll_id
   SET fr.lot_no = x.lot_no,
       fr.roll_no = 1;

ALTER TABLE fabric_rolls
  ADD UNIQUE KEY uq_rolls_lot (fabric_id, lot_no, roll_no);

-- 3) ราคาผ้าแต่ละผู้จัดจำหน่าย ──────────────────────────────────
-- source = 'purchase' : ระบบบันทึกเองตอนรับม้วนผ้าเข้า (ราคาที่ซื้อจริง)
-- source = 'quote'    : ราคาที่ร้านเสนอ/สอบถามมา ยังไม่ได้ซื้อ (fabric_id ว่างได้)
CREATE TABLE supplier_fabric_prices (
  price_id        INT(11) NOT NULL AUTO_INCREMENT,
  supplier_id     INT(11) NOT NULL,
  fabric_id       INT(11) NULL,
  type_id         INT(11) NOT NULL,
  category_id     INT(11) NULL,
  color_id        INT(11) NULL,
  price_per_meter DECIMAL(10,2) NOT NULL,
  min_order_meter DECIMAL(10,2) NULL,
  source          ENUM('purchase','quote') NOT NULL DEFAULT 'quote',
  roll_id         INT(11) NULL,
  price_date      DATE NOT NULL,
  note            VARCHAR(255) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (price_id),
  UNIQUE KEY uq_price_roll (roll_id),
  KEY idx_price_compare (type_id, category_id, color_id, price_date),
  KEY idx_price_supplier (supplier_id, price_date),
  CONSTRAINT fk_price_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (supplier_id),
  CONSTRAINT fk_price_fabric   FOREIGN KEY (fabric_id)   REFERENCES fabrics (fabric_id) ON DELETE SET NULL,
  CONSTRAINT fk_price_type     FOREIGN KEY (type_id)     REFERENCES fabric_types (type_id),
  CONSTRAINT fk_price_category FOREIGN KEY (category_id) REFERENCES category (category_id),
  CONSTRAINT fk_price_color    FOREIGN KEY (color_id)    REFERENCES Color (color_id),
  CONSTRAINT fk_price_roll     FOREIGN KEY (roll_id)     REFERENCES fabric_rolls (roll_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- ราคาจากม้วนที่เคยซื้อแล้ว
INSERT INTO supplier_fabric_prices
  (supplier_id, fabric_id, type_id, category_id, color_id,
   price_per_meter, source, roll_id, price_date)
SELECT fr.supplier_id, f.fabric_id, f.type_id, f.category_id, f.color_id,
       fr.cost_per_meter, 'purchase', fr.roll_id,
       COALESCE(fr.purchase_date, DATE(fr.created_at))
  FROM fabric_rolls fr
  JOIN fabrics f ON f.fabric_id = fr.fabric_id
 WHERE fr.deleted_at IS NULL;

-- ราคาล่าสุดของแต่ละร้าน ต่อ ประเภท/ลวดลาย/สี
-- ใช้: SELECT * FROM v_fabric_price_compare
--      WHERE type_id = ? AND category_id = ? AND color_id = ?
--      ORDER BY price_per_meter;
CREATE OR REPLACE VIEW v_fabric_price_compare AS
SELECT x.supplier_id, s.supplier_name,
       x.type_id, ft.type_name,
       x.category_id, c.category_name,
       x.color_id, col.color_name,
       x.fabric_id, x.price_per_meter, x.min_order_meter,
       x.source, x.price_date
  FROM (
    SELECT p.*,
           ROW_NUMBER() OVER (
             PARTITION BY p.supplier_id, p.type_id, p.category_id, p.color_id
             ORDER BY p.price_date DESC, p.price_id DESC
           ) AS rn
      FROM supplier_fabric_prices p
     WHERE p.deleted_at IS NULL
  ) x
  JOIN suppliers s          ON s.supplier_id  = x.supplier_id
  JOIN fabric_types ft      ON ft.type_id     = x.type_id
  LEFT JOIN category c      ON c.category_id  = x.category_id
  LEFT JOIN Color col       ON col.color_id   = x.color_id
 WHERE x.rn = 1
   AND s.deleted_at IS NULL;
