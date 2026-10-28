const { pool } = require('../db');

/* =========================
   บันทึกกิจกรรม (activity_logs)
   - logActivity(): เขียน log 1 แถว (เรียกเองได้จากทุก route)
   - activityLogger: middleware ที่บันทึกทุกคำขอ POST/PUT/PATCH/DELETE ให้อัตโนมัติ
   ผู้ใช้ระบุจาก header "X-User-Id" ที่หน้าเว็บแนบมา (อ่านจาก localStorage ตอนล็อกอิน)
========================= */

/* ส่วนแรกของ path → โมดูล + ชื่อสิ่งของที่ใช้เขียนรายละเอียด
   module เก็บเป็นรหัสอังกฤษ (ให้ตรงกับข้อมูลเดิมในตาราง) หน้าเว็บค่อยแปลเป็นไทย */
const RESOURCES = {
  users:                   { module: 'users',      entity: 'ผู้ใช้งาน' },
  auth:                    { module: 'users',      entity: 'ผู้ใช้งาน' },
  employee:                { module: 'users',      entity: 'พนักงาน' },
  tokens:                  { module: 'users',      entity: 'โทเคน' },
  'api/products':          { module: 'products',   entity: 'สินค้า' },
  sizes:                   { module: 'products',   entity: 'ไซซ์' },
  category:                { module: 'products',   entity: 'หมวดหมู่' },
  color:                   { module: 'products',   entity: 'สี' },
  'api/outfit-formulas':   { module: 'products',   entity: 'สูตรชุด' },
  fabric:                  { module: 'stock',      entity: 'ผ้า' },
  fabricrolls:             { module: 'stock',      entity: 'ม้วนผ้า' },
  fabrictypes:             { module: 'stock',      entity: 'ประเภทผ้า' },
  fabricusage:             { module: 'stock',      entity: 'การใช้ผ้า' },
  Stock:                   { module: 'stock',      entity: 'สต๊อก' },
  suppliers:               { module: 'stock',      entity: 'ซัพพลายเออร์' },
  supplier_fabric_history: { module: 'stock',      entity: 'ประวัติรับผ้า' },
  purchase_orders:         { module: 'stock',      entity: 'ใบสั่งซื้อ' },
  purchase_order_items:    { module: 'stock',      entity: 'รายการใบสั่งซื้อ' },
  'api/fabric-calculator': { module: 'stock',      entity: 'การคำนวณผ้า' },
  bill:                    { module: 'sales',      entity: 'บิล' },
  Detailbill:              { module: 'sales',      entity: 'รายการบิล' },
  payment:                 { module: 'sales',      entity: 'การชำระเงิน' },
  tailoringorders:         { module: 'sales',      entity: 'ออเดอร์ตัดชุด' },
  promotion:               { module: 'promotion',  entity: 'โปรโมชั่น' },
  shop_settings:           { module: 'settings',   entity: 'ตั้งค่าร้าน' },
};

/* คำขอที่ไม่ต้องบันทึก (ไม่ได้เปลี่ยนข้อมูล หรือเป็นตัว log เอง) */
const SKIP = [
  /^\/activity_logs/,
  /^\/geo\//,
  /^\/api\/fabric-calculator\/preview/,
];

/* ขั้นตอนย่อยที่หน้าเว็บยิงทีละแถวต่อจากการกระทำหลัก
   เช่น เปิดบิล 1 ใบ = POST /bill 1 ครั้ง + POST /Detailbill ทุกรายการสินค้า
   ถ้าสำเร็จไม่ต้องบันทึก (การกระทำหลักบันทึกไว้แล้ว) เก็บเฉพาะตอนผิดพลาด */
const SUB_STEPS = [
  /^\/Detailbill/i,
  /^\/purchase_order_items/,
];

/* คำพิเศษใน path → action (ที่เหลือใช้ method ตัดสิน) */
const PATH_ACTIONS = {
  login: 'login',
  logout: 'logout',
  register: 'register',
  delete: 'delete',
  delete_stock: 'delete',
  add_stock: 'create',
  edit_stock: 'update',
  toggle: 'toggle',
  settle: 'settle',
  'link-bill': 'link_bill',
  photos: 'upload_photo',
  commit: 'commit',
  quote: 'quote',
  use: 'use',
  receive: 'receive',
};

const METHOD_ACTIONS = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

const ACTION_TH = {
  create: 'เพิ่ม',
  update: 'แก้ไข',
  delete: 'ลบ',
  toggle: 'เปิด/ปิด',
  settle: 'ชำระยอด',
  link_bill: 'ผูกบิลกับ',
  upload_photo: 'อัปโหลดรูป',
  commit: 'ตัดสต๊อกจาก',
  quote: 'บันทึกใบเสนอราคาจาก',
  use: 'ใช้',
  receive: 'ตรวจรับสินค้า',
  register: 'สมัครสมาชิก',
};

/* ชื่อที่อ่านรู้เรื่องของสิ่งที่ถูกแก้ (ลองหลายฟิลด์ เพราะแต่ละตารางตั้งชื่อไม่เหมือนกัน) */
const NAME_FIELDS = [
  'name', 'fabric_name', 'supplier_name', 'type_name', 'color_name', 'category_name',
  'outfitName', 'size_code', 'Payment_type', 'Promotion_details', 'promo_code',
  'roll_code', 'po_code', 'customer_name', 'Bill_details', 'title', 'code', 'email',
];

function pickName(body) {
  if (!body || typeof body !== 'object') return null;
  for (const f of NAME_FIELDS) {
    const v = body[f];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 100);
  }
  return null;
}

function pickId(body) {
  if (!body || typeof body !== 'object') return null;
  for (const k of ['id', 'insertId', 'idBill']) {
    if (body[k] != null) return body[k];
  }
  return null;
}

function resolveResource(path) {
  const parts = path.split('/').filter(Boolean);
  const two = parts.slice(0, 2).join('/');
  if (RESOURCES[two]) return { key: two, rest: parts.slice(2), ...RESOURCES[two] };
  if (RESOURCES[parts[0]]) return { key: parts[0], rest: parts.slice(1), ...RESOURCES[parts[0]] };
  return { key: parts[0] || '', rest: parts.slice(1), module: 'other', entity: parts[0] || '' };
}

function statusFromCode(code) {
  if (code >= 500) return 'error';
  if (code >= 400) return 'warning';
  return 'success';
}

/* user_id จาก header ต้องเป็นเลขจำนวนเต็มบวก ไม่งั้นถือว่าไม่รู้ว่าใคร */
function headerUserId(req) {
  const n = Number(req.headers['x-user-id']);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function logActivity({ userId = null, module, action, detail = null, status = 'success', logType = 'USER' }) {
  const sql =
    'INSERT INTO activity_logs (user_id, module, action, detail, status, log_type) VALUES (?, ?, ?, ?, ?, ?)';
  const vals = [module, String(action).slice(0, 50), detail, status, logType];
  try {
    await pool.query(sql, [userId, ...vals]);
  } catch (e) {
    /* user_id ไม่มีอยู่จริงในตาราง users (FK) → บันทึกแบบไม่ระบุผู้ใช้แทน ดีกว่าหาย */
    if (e.code === 'ER_NO_REFERENCED_ROW_2' && userId != null) {
      try { await pool.query(sql, [null, ...vals]); } catch (e2) { console.error('activity log error:', e2.message); }
    } else {
      console.error('activity log error:', e.message);
    }
  }
}

/* middleware: ดักทุกคำขอที่เปลี่ยนข้อมูล แล้วบันทึกหลังส่งคำตอบเสร็จ
   (ไม่ทำให้คำขอช้าลง และ log พังก็ไม่กระทบการทำงานหลัก) */
function activityLogger(req, res, next) {
  if (!METHOD_ACTIONS[req.method]) return next();
  const path = req.path;
  if (SKIP.some((re) => re.test(path))) return next();

  /* เก็บ body ที่ route ส่งกลับ เพื่อเอา id ที่เพิ่งสร้าง / ข้อความผิดพลาด / ข้อมูลผู้ใช้ตอนล็อกอิน */
  let resBody = null;
  const origJson = res.json.bind(res);
  res.json = (body) => {
    resBody = body;
    return origJson(body);
  };

  res.on('finish', () => {
    const r = resolveResource(path);
    const status = statusFromCode(res.statusCode);
    if (status === 'success' && SUB_STEPS.some((re) => re.test(path))) return;
    const reqBody = req.body || {};
    const errMsg = status !== 'success' && resBody?.message ? ` (${String(resBody.message).slice(0, 150)})` : '';
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();

    const special = r.rest.map((p) => PATH_ACTIONS[p]).find(Boolean);
    const action = special || METHOD_ACTIONS[req.method];
    let userId = headerUserId(req);
    let detail;

    if (action === 'login') {
      const email = typeof reqBody.email === 'string' ? reqBody.email.trim() : '';
      if (status === 'success') {
        userId = resBody?.id ?? userId;
        detail = `เข้าสู่ระบบสำเร็จ (${email}) จาก IP ${ip}`;
      } else {
        detail = `เข้าสู่ระบบไม่สำเร็จ (${email}) จาก IP ${ip}${errMsg}`;
      }
    } else if (action === 'logout') {
      detail = `ออกจากระบบ จาก IP ${ip}`;
    } else {
      const id = r.rest.find((p) => /^\d+$/.test(p)) ?? pickId(resBody);
      const name = pickName(reqBody);
      const verb = ACTION_TH[action] || action;
      detail = [
        `${verb}${r.entity}`,
        id != null ? `#${id}` : null,
        name ? `"${name}"` : null,
      ].filter(Boolean).join(' ');
      if (status !== 'success') detail = `${detail} ไม่สำเร็จ${errMsg}`;
    }

    logActivity({ userId, module: r.module, action, detail, status });
  });

  next();
}

module.exports = { logActivity, activityLogger };
