/* ═══════════════════════════════════════════════════════════════
   เบอร์โทรต้องเป็นตัวเลข 10 หลักเท่านั้น
   รับค่าที่ผู้ใช้พิมพ์มาแบบมีขีด/เว้นวรรคได้ แต่เก็บลงฐานข้อมูลเป็นตัวเลขล้วน
   (ฐานข้อมูลมี CHECK คุมอีกชั้น — ตรงนี้ไว้ตอบ error ที่อ่านรู้เรื่อง)
═══════════════════════════════════════════════════════════════ */
const digitsOnly = (v) => String(v ?? "").replace(/\D/g, "");

/* คืน { ok, value, message } — ว่าง/ไม่ส่งมา = ไม่ระบุเบอร์ (ผ่าน) */
function normalizePhone(value, { required = false, label = "เบอร์โทร" } = {}) {
  const digits = digitsOnly(value);
  if (!digits) {
    return required
      ? { ok: false, value: null, message: `กรุณากรอก${label}ให้ครบ 10 หลัก` }
      : { ok: true, value: null };
  }
  if (digits.length !== 10) {
    return { ok: false, value: null, message: `${label}ต้องเป็นตัวเลข 10 หลัก (กรอกมา ${digits.length} หลัก)` };
  }
  return { ok: true, value: digits };
}

module.exports = { digitsOnly, normalizePhone };
