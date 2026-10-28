-- ═══════════════════════════════════════════════════════════════
-- 2026-10-17 (รอบสอง) — สั่งซื้อ → ตรวจรับ → ม้วนผ้าเข้าคลัง
-- 1) รายการในใบสั่งซื้อเก็บ "สเปกผ้าที่สั่ง" (ประเภท/ลวดลาย/สี/ชื่อ)
--    ผ้าที่ยังไม่เคยมี → fabric_id ว่างไว้ก่อน แล้วค่อยสร้างใน fabrics ตอนตรวจรับ
-- 2) ม้วนผ้าผูกกับรายการในใบสั่งซื้อที่มันมา (po_item_id)
-- ═══════════════════════════════════════════════════════════════

-- 1) purchase_order_items ───────────────────────────────────────
ALTER TABLE purchase_order_items
  ADD COLUMN type_id INT(11) NULL AFTER fabric_id,
  ADD COLUMN category_id INT(11) NULL AFTER type_id,
  ADD COLUMN color_id INT(11) NULL AFTER category_id,
  ADD COLUMN fabric_name VARCHAR(150) NULL AFTER color_id;

-- รายการเดิม: เอาสเปกจากผ้าที่อ้างถึงอยู่
UPDATE purchase_order_items poi
  JOIN fabrics f ON f.fabric_id = poi.fabric_id
   SET poi.type_id = f.type_id,
       poi.category_id = f.category_id,
       poi.color_id = f.color_id,
       poi.fabric_name = f.fabric_name;

ALTER TABLE purchase_order_items
  ADD CONSTRAINT fk_poi_type     FOREIGN KEY (type_id)     REFERENCES fabric_types (type_id),
  ADD CONSTRAINT fk_poi_category FOREIGN KEY (category_id) REFERENCES category (category_id),
  ADD CONSTRAINT fk_poi_color    FOREIGN KEY (color_id)    REFERENCES Color (color_id);

-- 2) fabric_rolls ────────────────────────────────────────────────
-- NULL = ม้วนที่เพิ่มเองจากหน้าเพิ่มม้วนผ้า (ไม่ได้มาจากใบสั่งซื้อ)
ALTER TABLE fabric_rolls
  ADD COLUMN po_item_id INT(11) NULL AFTER supplier_id,
  ADD KEY idx_rolls_po_item (po_item_id),
  ADD CONSTRAINT fk_rolls_po_item FOREIGN KEY (po_item_id) REFERENCES purchase_order_items (item_id) ON DELETE SET NULL;
