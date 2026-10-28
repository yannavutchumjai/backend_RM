const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/* ═══════════════════════════════════════════════════════════════
   โปรโมชั่นมีทั้ง "ช่วงเวลา" และ "จำนวนสิทธิ์"
   - start_at / end_at = NULL → ไม่จำกัดเวลา
   - usage_limit       = NULL → ไม่จำกัดสิทธิ์
   สิทธิ์ที่ใช้ไปแล้ว นับจากบิลจริงที่ยังไม่ถูกยกเลิก (1 บิล = 1 สิทธิ์)
   ไม่เก็บเป็นตัวเลขแยก เพราะยกเลิกบิลแล้วสิทธิ์ต้องคืนเองโดยอัตโนมัติ
═══════════════════════════════════════════════════════════════ */
const USED_COUNT = `
  (SELECT COUNT(DISTINCT d.Bill_idBill)
     FROM Detail_bill d
     JOIN Bill b ON b.idBill = d.Bill_idBill AND b.deleted_at IS NULL
    WHERE d.Promotion_idPromotion = p.idPromotion AND d.deleted_at IS NULL)
`;

const SELECT_COLUMNS = `
  p.idPromotion, p.Promotion_details, p.promo_code, p.PER_ITEM,
  p.start_at, p.end_at, p.usage_limit,
  p.is_active, p.created_at, p.updated_at, p.deleted_at,
  ${USED_COUNT} AS used_count
`;

/* หมดเวลา/สิทธิ์เต็มแล้ว → ปิดโปรโมชั่นทันทีที่มีการอ่านข้อมูล
   (ทำที่ชั้นข้อมูล จะเปิดหน้าไหนหรือยิง API ตัวไหนก็ปิดให้เหมือนกันหมด) */
async function closeExhaustedPromotions() {
  await pool.query(`
    UPDATE Promotion p
       SET p.is_active = 0, p.updated_at = NOW()
     WHERE p.deleted_at IS NULL
       AND p.is_active = 1
       AND (
             (p.end_at IS NOT NULL AND p.end_at < NOW())
          OR (p.usage_limit IS NOT NULL AND ${USED_COUNT} >= p.usage_limit)
       )
  `);
}

/* สถานะที่เอาไว้แสดงผล — แยก "ยังไม่ถึงเวลา" ออกจาก "ปิดเอง" */
function decorate(row) {
  const now = new Date();
  const used = Number(row.used_count) || 0;
  const limit = row.usage_limit === null || row.usage_limit === undefined ? null : Number(row.usage_limit);
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const start = row.start_at ? new Date(row.start_at) : null;
  const end = row.end_at ? new Date(row.end_at) : null;

  let status = "active";
  if (!Number(row.is_active)) status = "off";
  if (end && end < now) status = "expired";
  else if (limit !== null && used >= limit) status = "used_up";
  else if (start && start > now) status = "scheduled";

  return {
    ...row,
    used_count: used,
    remaining_quota: remaining,
    status,
    /* ใช้ตอนนี้ได้จริงไหม — หน้าออกบิลใช้ตัวนี้ตัดสิน */
    is_usable: status === "active",
  };
}

// ✅ GET /promotion  (โชว์เฉพาะที่ยังไม่ถูกลบ)
router.get("/", async (_req, res) => {
  try {
    await closeExhaustedPromotions();
    const [rows] = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM Promotion p
        WHERE p.deleted_at IS NULL
        ORDER BY p.idPromotion DESC`
    );
    res.json(rows.map(decorate));
  } catch (e) {
    console.error("GET /promotion error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ GET /promotion/all (ดูทั้งหมดรวมที่ถูกลบ)
router.get("/all", async (_req, res) => {
  try {
    await closeExhaustedPromotions();
    const [rows] = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM Promotion p ORDER BY p.idPromotion DESC`
    );
    res.json(rows.map(decorate));
  } catch (e) {
    console.error("GET /promotion/all error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ GET /promotion/:id
router.get("/:id", async (req, res) => {
  try {
    await closeExhaustedPromotions();
    const [rows] = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM Promotion p WHERE p.idPromotion = ? LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json(decorate(rows[0]));
  } catch (e) {
    console.error("GET /promotion/:id error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

/* ค่าว่างจากฟอร์ม ("" หรือไม่ส่งมา) = ไม่จำกัด → เก็บเป็น NULL */
const orNull = (v) => (v === undefined || v === null || v === "" ? null : v);
const intOrNull = (v) => {
  const n = orNull(v);
  return n === null ? null : Math.max(0, Number(n) || 0);
};
/* input type="datetime-local" ส่งมาเป็น 2026-08-26T14:30 — MySQL ต้องการช่องว่าง */
const dateOrNull = (v) => {
  const d = orNull(v);
  return d === null ? null : String(d).replace("T", " ").slice(0, 19);
};

// ✅ POST /promotion (เพิ่มโปรโมชั่น)
router.post("/", async (req, res) => {
  try {
    const { Promotion_details, promo_code, PER_ITEM, start_at, end_at, usage_limit } = req.body || {};

    if (!Promotion_details || !promo_code || PER_ITEM === undefined) {
      return res.status(400).json({ message: "Promotion_details, promo_code, PER_ITEM are required" });
    }

    const start = dateOrNull(start_at);
    const end = dateOrNull(end_at);
    if (start && end && end < start) {
      return res.status(400).json({ message: "เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม" });
    }

    const [result] = await pool.query(
      `INSERT INTO Promotion
        (Promotion_details, promo_code, PER_ITEM, start_at, end_at, usage_limit, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [Promotion_details, promo_code, PER_ITEM, start, end, intOrNull(usage_limit)]
    );

    res.status(201).json({
      idPromotion: result.insertId,
      Promotion_details,
      promo_code,
      PER_ITEM,
      start_at: start,
      end_at: end,
      usage_limit: intOrNull(usage_limit),
      is_active: 1,
    });
  } catch (e) {
    console.error("POST /promotion error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ PUT /promotion/:id (แก้ไขข้อมูล)
router.put("/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const {
      Promotion_details = null,
      promo_code = null,
      PER_ITEM = null,
      start_at,
      end_at,
      usage_limit,
    } = req.body || {};

    const start = dateOrNull(start_at);
    const end = dateOrNull(end_at);
    if (start && end && end < start) {
      conn.release();
      return res.status(400).json({ message: "เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม" });
    }

    /* เวลา/สิทธิ์ เขียนทับตรง ๆ (ไม่ใช้ COALESCE) เพราะ "ล้างค่าให้ว่าง"
       ต้องหมายถึงไม่จำกัด ไม่ใช่คงค่าเดิมไว้ */
    const [result] = await conn.query(
      `UPDATE Promotion
       SET Promotion_details = COALESCE(?, Promotion_details),
           promo_code = COALESCE(?, promo_code),
           PER_ITEM = COALESCE(?, PER_ITEM),
           start_at = ?,
           end_at = ?,
           usage_limit = ?,
           updated_at = NOW()
       WHERE idPromotion = ? AND deleted_at IS NULL`,
      [Promotion_details, promo_code, PER_ITEM, start, end, intOrNull(usage_limit), id]
    );

    if (!result.affectedRows) return res.status(404).json({ message: "Not found" });

    res.json({ message: "Updated" });
  } catch (e) {
    console.error("PUT /promotion/:id error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  } finally {
    conn.release();
  }
});

// ✅ PUT /promotion/toggle/:id (เปิด/ปิดการใช้งาน)
router.put("/toggle/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;

    /* เปิดกลับมาไม่ได้ถ้าหมดเวลา/สิทธิ์เต็มแล้ว — ต้องไปแก้เวลาหรือเพิ่มสิทธิ์ก่อน */
    const [[promo]] = await conn.query(
      `SELECT p.idPromotion, p.is_active, p.end_at, p.usage_limit, ${USED_COUNT} AS used_count
         FROM Promotion p WHERE p.idPromotion = ? AND p.deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!promo) return res.status(404).json({ message: "Not found" });

    if (!Number(promo.is_active)) {
      const expired = promo.end_at && new Date(promo.end_at) < new Date();
      const usedUp = promo.usage_limit !== null && Number(promo.used_count) >= Number(promo.usage_limit);
      if (expired || usedUp) {
        return res.status(400).json({
          message: expired
            ? "โปรโมชั่นนี้หมดเวลาแล้ว — แก้เวลาสิ้นสุดก่อนจึงจะเปิดได้"
            : "สิทธิ์ของโปรโมชั่นนี้ถูกใช้ครบแล้ว — เพิ่มจำนวนสิทธิ์ก่อนจึงจะเปิดได้",
        });
      }
    }

    await conn.query(
      `UPDATE Promotion
       SET is_active = IF(is_active = 1, 0, 1), updated_at = NOW()
       WHERE idPromotion = ? AND deleted_at IS NULL`,
      [id]
    );

    const [rows] = await conn.query(
      `SELECT idPromotion, is_active FROM Promotion WHERE idPromotion = ? LIMIT 1`,
      [id]
    );

    res.json({ message: "Toggled", data: rows[0] });
  } catch (e) {
    console.error("PUT /promotion/toggle/:id error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  } finally {
    conn.release();
  }
});

// ✅ PUT /promotion/delete/:id (ลบแบบ soft delete: หายจากหน้าเว็บ แต่ยังอยู่ DB)
router.put("/delete/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;

    const [result] = await conn.query(
      `UPDATE Promotion
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE idPromotion = ? AND deleted_at IS NULL`,
      [id]
    );

    if (!result.affectedRows) return res.status(404).json({ message: "Not found" });

    res.json({ message: "Deleted" });
  } catch (e) {
    console.error("PUT /promotion/delete/:id error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  } finally {
    conn.release();
  }
});

module.exports = router;
