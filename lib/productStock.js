/* ═══════════════════════════════════════════════════════════════
   สินค้า 2 แหล่ง (products.source)
   - made   = ร้านตัดเอง — เกิดจากหน้าตั้งราคา (ตัดผ้าจากคลัง) เท่านั้น เพิ่มตรง ๆ ไม่ได้
              เริ่มที่สถานะ "กำลังตัด" → กด "ตัดเสร็จ" แล้วจึงเป็น "พร้อมขาย"
   - resale = รับมาขายจากที่อื่น — เพิ่มจากหน้าสินค้า ระบุจำนวนที่รับเข้าเอง

   จำนวนคงเหลือ
   - ผลิต (made_qty)           = จำนวนชุดที่ตัด (fabric_calc_sessions.product_id)
   - รับเข้า/ปรับ (stock_adjust) = จำนวนที่รับเข้าของสินค้ารับมาขาย
   - ขาย (sold_qty)            = จำนวนในบิลจริงที่ยังไม่ถูกยกเลิก
   - คงเหลือ (stock)           = ผลิต + รับเข้า − ขาย
   ไม่เก็บคงเหลือเป็นตัวเลขตรง ๆ เพราะยกเลิกบิลแล้วต้องคืนสต็อกเองโดยอัตโนมัติ
═══════════════════════════════════════════════════════════════ */
const SOURCE_MADE = "made";
const SOURCE_RESALE = "resale";

const STATUS_READY = "พร้อมขาย";
const STATUS_OFF = "ไม่พร้อมขาย";
const STATUS_CUTTING = "กำลังตัด";

const MADE_SQL = `
  (SELECT SUM(s.qty) FROM fabric_calc_sessions s WHERE s.product_id = p.id)
`;

const SOLD_SQL = `
  (SELECT COALESCE(SUM(d.quantity), 0)
     FROM Detail_bill d
     JOIN Bill b ON b.idBill = d.Bill_idBill AND b.deleted_at IS NULL
    WHERE d.Products_idProducts = p.id AND d.deleted_at IS NULL)
`;

const STOCK_COLUMNS = `
  ${MADE_SQL} AS made_qty,
  ${SOLD_SQL} AS sold_qty,
  p.stock_adjust AS stock_adjust
`;

/* แปลงตัวเลขจาก SQL + คำนวณคงเหลือ */
function withStock(row) {
  const made = Number(row.made_qty) || 0;
  const adjust = Number(row.stock_adjust) || 0;
  const sold = Number(row.sold_qty) || 0;
  return {
    ...row,
    made_qty: made,
    stock_adjust: adjust,
    sold_qty: sold,
    stock_qty: Math.max(0, made + adjust - sold),
  };
}

/* ตั้งให้คงเหลือเท่ากับ target — คืนค่า stock_adjust ที่ต้องเก็บ */
const adjustFor = (row, target) =>
  Math.max(0, Math.floor(Number(target) || 0)) - (Number(row.made_qty) || 0) + (Number(row.sold_qty) || 0);

/* คงเหลือ + สถานะของสินค้าหนึ่งตัว (ใช้ตรวจตอนเปิดบิล) */
async function stockOf(db, productId) {
  const [[row]] = await db.query(
    `SELECT p.id, p.status, p.source, ${STOCK_COLUMNS} FROM products p WHERE p.id = ? AND p.deleted_at IS NULL`,
    [productId]
  );
  return row ? withStock(row) : null;
}

/* เหตุผลที่ขายไม่ได้ — ยังตัดไม่เสร็จ หรือร้านปิดขายไว้ (null = ขายได้) */
const notSellableReason = (row) => {
  if (!row) return "ไม่พบสินค้านี้";
  if (row.status === STATUS_CUTTING) return "สินค้านี้ยังตัดไม่เสร็จ ขายไม่ได้";
  if (row.status === STATUS_OFF) return "สินค้านี้ตั้งสถานะไม่พร้อมขาย";
  return null;
};

module.exports = {
  STOCK_COLUMNS, withStock, stockOf, adjustFor, notSellableReason,
  SOURCE_MADE, SOURCE_RESALE, STATUS_READY, STATUS_OFF, STATUS_CUTTING,
};
