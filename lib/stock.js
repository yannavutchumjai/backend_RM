/* สถานะม้วนผ้าตามความยาวคงเหลือ — ใช้ทั้งตอนเพิ่ม/แก้ม้วนและตอนตัดผ้าออก
   ต่ำกว่า 10 เมตรถือว่าใกล้หมด ตรงกับหน้า Fabric.jsx */
const LOW_STOCK_METERS = 10;

const rollStatusOf = (remaining) => {
  const r = Number(remaining) || 0;
  if (r <= 0) return "out_of_stock";
  if (r < LOW_STOCK_METERS) return "low_stock";
  return "normal";
};

module.exports = { LOW_STOCK_METERS, rollStatusOf };
