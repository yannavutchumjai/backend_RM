/* ═══════════════════════════════════════════════════════════════
   ช่วงขนาดของชุด (ตาราง product_size_ranges) — กรอกตอนกด "ตัดเสร็จ"
   1 แถว = 1 จุดวัด: ใส่ได้ตั้งแต่ min_cm ถึง max_cm (หน่วยซม.)
   ไว้ตอบลูกค้าว่าควรใส่ตัวไหน — products.size เก็บข้อความสรุปไว้ให้หน้าที่อ่านแค่ size
═══════════════════════════════════════════════════════════════ */
const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

const fmt = (n) => String(Number(n));

/* ตรวจ + จัดรูปแถวจากฟอร์ม — คืน { rows } หรือ { error } */
function cleanRanges(input) {
  const list = Array.isArray(input) ? input : [];
  const rows = [];
  for (const r of list) {
    const label = String(r?.field_label ?? r?.label ?? "").trim().slice(0, 100);
    const min = num(r?.min_cm);
    const max = num(r?.max_cm);
    /* แถวว่างทั้งแถว = ข้าม */
    if (!label && min === null && max === null) continue;
    if (!label) return { error: "ทุกแถวต้องมีชื่อจุดวัด" };
    if (min === null || max === null || min <= 0 || max <= 0)
      return { error: `กรอกขนาด "${label}" ให้ครบทั้งตั้งแต่และถึง` };
    if (min > max) return { error: `ขนาด "${label}" ตั้งแต่ต้องไม่มากกว่าถึง` };
    rows.push({
      field_key: String(r?.field_key || "").trim().slice(0, 50) || null,
      field_label: label,
      min_cm: min,
      max_cm: max,
    });
  }
  return { rows };
}

/* ข้อความสรุปสำหรับ products.size เช่น "รอบอก 86–92 · รอบเอว 70–76 ซม." */
function sizeText(rows) {
  if (!rows.length) return null;
  const parts = rows.map((r) => `${r.field_label} ${fmt(r.min_cm)}–${fmt(r.max_cm)}`);
  return `${parts.join(" · ")} ซม.`.slice(0, 120);
}

/* เขียนช่วงขนาดของสินค้าใหม่ทั้งชุด + อัปเดตข้อความสรุปใน products.size */
async function saveRanges(conn, productId, rows) {
  await conn.query("DELETE FROM product_size_ranges WHERE product_id = ?", [productId]);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await conn.query(
      `INSERT INTO product_size_ranges (product_id, field_key, field_label, min_cm, max_cm, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [productId, r.field_key, r.field_label, r.min_cm, r.max_cm, i + 1]
    );
  }
  const text = sizeText(rows);
  await conn.query("UPDATE products SET size = ? WHERE id = ?", [text, productId]);
  return text;
}

/* ช่วงขนาดของสินค้าหลายตัว → { [product_id]: [...] } */
async function rangesByProduct(db, ids) {
  if (!ids.length) return {};
  const [rows] = await db.query(
    `SELECT product_id, field_key, field_label, min_cm, max_cm
       FROM product_size_ranges WHERE product_id IN (?) ORDER BY product_id, sort_order, range_id`,
    [ids]
  );
  const map = {};
  rows.forEach((r) => {
    (map[r.product_id] = map[r.product_id] || []).push({
      field_key: r.field_key,
      field_label: r.field_label,
      min_cm: r.min_cm === null ? null : Number(r.min_cm),
      max_cm: r.max_cm === null ? null : Number(r.max_cm),
    });
  });
  return map;
}

module.exports = { cleanRanges, sizeText, saveRanges, rangesByProduct };
