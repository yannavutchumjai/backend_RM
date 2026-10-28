/* ═══════════════════════════════════════════════════════════════
   ล็อตสินค้า — สินค้าที่ชื่อและประเภทตรงกัน จะถูกจัดเป็นชุดเดียวกัน
   ไม่ใช้ลาย/ไซส์เทียบ — ชุดเดียวกันตัดจากผ้าคนละลายก็ยังต่อเลขล็อตเดิม
   และชุดที่ตัดเองยังไม่มีไซส์จนกว่าจะกดตัดเสร็จ
   รหัสล็อต = {id ของตัวแรกในชุด}_{ลำดับ 3 หลัก} เช่น 7_001, 7_002

   ใช้ร่วมกันระหว่างหน้าสินค้า และหน้าตั้งราคาขาย (ที่สร้างสินค้าใหม่ได้)
═══════════════════════════════════════════════════════════════ */
const normalize = (v) => String(v ?? "").trim().toLowerCase();

async function assignLot(db, id, { name, category_id }) {
  const [siblings] = await db.query(
    `SELECT id, group_no, lot_no FROM products
      WHERE deleted_at IS NULL AND id <> ?
        AND LOWER(TRIM(COALESCE(name, ''))) = ?
        AND COALESCE(category_id, 0) = ?
      ORDER BY lot_no ASC, id ASC`,
    [id, normalize(name), Number(category_id) || 0]
  );

  /* ยังไม่มีตัวที่เหมือนกัน → ตั้งชุดใหม่โดยใช้ id ตัวเองเป็นเลขชุด */
  const groupNo = siblings.length ? (siblings[0].group_no || siblings[0].id) : id;
  const lotNo = siblings.length
    ? Math.max(...siblings.map((s) => Number(s.lot_no) || 1)) + 1
    : 1;
  const lotCode = `${groupNo}_${String(lotNo).padStart(3, "0")}`;

  await db.query(
    "UPDATE products SET group_no = ?, lot_no = ?, lot_code = ? WHERE id = ?",
    [groupNo, lotNo, lotCode, id]
  );
  return { group_no: groupNo, lot_no: lotNo, lot_code: lotCode };
}

module.exports = { assignLot, normalize };
