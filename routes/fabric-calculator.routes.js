/* ═══════════════════════════════════════════════════════════════
   คำนวณราคาชุด (mount: /api/fabric-calculator)

   ร้านกรอกเอง: ค่าวัดตัวลูกค้า (เก็บใน note) + ผ้าที่ใช้กี่เมตรต่อชุดจากม้วนไหน
   ระบบไม่คำนวณปริมาณผ้าให้ — คิดแค่ราคา:
     ค่าผ้า     = เมตรต่อชุด × ราคาต่อเมตรของม้วน × จำนวนชุด
     ต้นทุนรวม  = ค่าผ้า + อุปกรณ์เสริม
   ไม่มีค่าแรง (ร้านจ่ายช่างเอง ระบบไม่รู้ตัวเลข)

   commit = ตัดผ้าออกจากม้วนจริง + (ถ้าตัดเพื่อขาย) สร้างสินค้า "กำลังตัด"
   กด "ตัดเสร็จ" ที่หน้าสินค้าแล้วจึงขายได้ (ดู product.routes.js)
═══════════════════════════════════════════════════════════════ */
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { rollStatusOf } = require("../lib/stock");
const { assignLot } = require("../lib/productLots");
const { SOURCE_MADE, STATUS_CUTTING } = require("../lib/productStock");

/* ม้วนผ้าพร้อมราคาต่อเมตรและความยาวคงเหลือ (เมตร) */
const ROLL_SELECT = `
  SELECT
    fr.roll_id,
    fr.roll_code,
    fr.lot_number,
    fr.fabric_id,
    f.fabric_name,
    ft.type_name,
    c.color_name,
    ROUND(COALESCE(f.width_cm, 0) / 2.54, 2) AS width_inch,
    fr.initial_length,
    fr.remaining_length AS length_remaining,
    fr.cost_per_meter AS price_per_meter,
    fr.status
  FROM fabric_rolls fr
  LEFT JOIN fabrics f       ON f.fabric_id = fr.fabric_id
  LEFT JOIN fabric_types ft ON ft.type_id = f.type_id
  LEFT JOIN Color c         ON c.color_id = f.color_id
  WHERE fr.deleted_at IS NULL
`;

/* =========================
   HELPERS
========================= */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

async function computeCalculation(conn, payload) {
  const {
    product_type,
    qty = 1,                         // ตัดทีละ 1 ชุด
    extra_cost_per_piece = 0,        // อุปกรณ์เสริม (กระดุม ซิป ซับใน) ต่อ 1 ชุด
    tailor_id = null,                // คนที่ตัดชุดนี้ (users.id)
    sell_price_per_piece = 0,        // ราคาขายที่เจ้าของร้านตั้งเอง
    note = null,
    items = [],
  } = payload || {};

  if (!product_type || !qty || Number(qty) <= 0) {
    throw new Error("product_type, qty จำเป็นต้องกรอก");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("ต้องมีผ้าที่ใช้อย่างน้อย 1 รายการ");
  }

  /* ใช้ม้วนเดียวกันหลายแถว → รวมความยาวก่อนเทียบกับที่เหลือในม้วน */
  const usedByRoll = {};
  const computedItems = [];
  let totalFabricCost = 0;
  const shortRolls = [];

  for (const item of items) {
    const { roll_id, part_name } = item || {};
    /* เมตรที่ร้านกรอก ต่อ 1 ชุด */
    const meters = Number(item?.meters_per_piece);

    if (!roll_id || !(meters > 0)) {
      throw new Error("ทุกแถวต้องเลือกม้วนผ้าและกรอกจำนวนเมตร");
    }

    const [rollRows] = await conn.query(`${ROLL_SELECT} AND fr.roll_id = ? LIMIT 1`, [roll_id]);

    if (!rollRows.length) {
      throw new Error(`ไม่พบม้วนผ้า roll_id = ${roll_id}`);
    }

    const roll = rollRows[0];

    const totalUsage = round2(meters * Number(qty));
    /* คงเหลือหลังตัด — ใช้ตรวจว่าผ้าพอ และอัปเดตม้วน (ไม่เก็บลงตารางคำนวณ) */
    const afterRemaining = round2(
      Number(roll.length_remaining || 0) - (usedByRoll[roll.roll_id] || 0) - totalUsage
    );
    usedByRoll[roll.roll_id] = round2((usedByRoll[roll.roll_id] || 0) + totalUsage);
    const costPerMeter = Number(roll.price_per_meter || 0);
    const totalCost = round2(totalUsage * costPerMeter);

    if (afterRemaining < 0) shortRolls.push(roll.roll_code || `#${roll.roll_id}`);
    totalFabricCost += totalCost;

    computedItems.push({
      roll_id: Number(roll.roll_id),
      roll_code: roll.roll_code,
      fabric_name: roll.fabric_name || "-",
      part_name: String(part_name || roll.fabric_name || "ผ้า").slice(0, 100),
      total_usage: totalUsage,
      after_remaining: afterRemaining,
      cost_per_meter: costPerMeter,
      total_cost: totalCost,
    });
  }

  totalFabricCost = round2(totalFabricCost);
  const totalExtraCost = round2(Math.max(0, Number(extra_cost_per_piece) || 0) * Number(qty));
  const totalCost = round2(totalFabricCost + totalExtraCost);
  /* ราคาขายมาจากที่เจ้าของร้านตั้งเอง
     ถ้ายังไม่ตั้ง ให้เท่ากับต้นทุน (กำไร 0) จะได้ไม่ขาดทุนโดยไม่รู้ตัว */
  const pricePerPiece = Number(sell_price_per_piece) > 0
    ? round2(Number(sell_price_per_piece))
    : round2(totalCost / Number(qty));
  const totalSellPrice = round2(pricePerPiece * Number(qty));

  return {
    product_type,
    qty: Number(qty),
    tailor_id: tailor_id ? Number(tailor_id) : null,
    total_fabric_cost: totalFabricCost,
    total_extra_cost: totalExtraCost,
    total_cost: totalCost,
    total_sell_price: totalSellPrice,
    price_per_piece: pricePerPiece,
    profit: round2(totalSellPrice - totalCost),
    short_rolls: shortRolls,
    note,
    items: computedItems,
  };
}

/* ── ชุดที่ตัดเพื่อขาย → สร้างสินค้าในคลัง (ตาราง products) สถานะ "กำลังตัด" ──
   ชื่อสินค้า = ชื่อแบบชุดอัตโนมัติ (เจ้าของร้านไม่ต้องกรอก) แยกกันด้วยเลขล็อต
   1 แถว = สินค้า 1 รายการ (ขายได้หลายชิ้น) จำนวนที่ขายได้ = จำนวนชุดที่ตัด (ดู utils/productStock)
   ตัดแบบเดิม ลายเดิม หมวดเดิมอีกรอบ → ต่อเป็นล็อตถัดไปของชุดเดิม (เช่น 7_002)
   ขายได้หลังกด "ตัดเสร็จ" + กรอกช่วงขนาดที่หน้าสินค้า */
async function outfitParts(conn, outfitName) {
  const [rows] = await conn.query(
    `SELECT p.part_name
       FROM outfit_formula f
       JOIN outfit_formula_part p ON p.formula_id = f.formula_id
      WHERE f.outfit_name = ? AND f.deleted_at IS NULL
      ORDER BY p.sort_order, p.part_id`,
    [outfitName]
  );
  return rows.map((r) => r.part_name).filter(Boolean);
}

async function createProduct(conn, product, computed, calcId) {
  const name = String(computed.product_type || "").trim().slice(0, 255);
  if (!name) throw new Error("ไม่พบชื่อแบบชุด");

  const categoryId = Number(product.category_id) || null;
  let categoryName = null;
  if (categoryId) {
    const [rows] = await conn.query(
      "SELECT category_id, category_name FROM product_category WHERE category_id = ? AND deleted_at IS NULL",
      [categoryId]
    );
    if (!rows.length) throw new Error("ไม่พบหมวดหมู่สินค้าที่เลือก");
    categoryName = rows[0].category_name;
  }

  const qty = Number(computed.qty) || 1;
  const pattern = String(product.pattern || "").trim().slice(0, 255) || null;
  /* ไซส์ยังไม่รู้ — กรอกเป็นช่วงขนาดตอนกดตัดเสร็จ */
  const size = null;
  /* ชุดใหม่ (ยังไม่มีแบบชุดนี้) → บันทึกเป็นแบบชุดพร้อมชิ้นส่วนที่เขียนมาให้เลย */
  if (!(await outfitParts(conn, name)).length) {
    const partNames = (Array.isArray(product?.parts) ? product.parts : [])
      .map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean);
    const [[exists]] = await conn.query(
      "SELECT formula_id FROM outfit_formula WHERE outfit_name = ? AND deleted_at IS NULL LIMIT 1", [name]
    );
    if (!exists && partNames.length) {
      const [f] = await conn.query(
        "INSERT INTO outfit_formula (outfit_name, sort_order) VALUES (?, 99)",
        [name.slice(0, 150)]
      );
      for (let i = 0; i < partNames.length; i++) {
        await conn.query(
          "INSERT INTO outfit_formula_part (formula_id, part_name, sort_order) VALUES (?, ?, ?)",
          [f.insertId, partNames[i], i + 1]
        );
      }
    }
  }
  const [r] = await conn.query(
    `INSERT INTO products (name, pattern, size, price, cost, description, category_id, category, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, pattern, size, computed.price_per_piece, round2(computed.total_cost / qty),
      `ตัดจากรอบตัด #${calcId} (${computed.product_type} ${qty} ชุด)`,
      categoryId, categoryName, STATUS_CUTTING, SOURCE_MADE,
    ]
  );
  const lot = await assignLot(conn, r.insertId, { name, category_id: categoryId });
  await conn.query("UPDATE fabric_calc_sessions SET product_id = ? WHERE calc_id = ?", [r.insertId, calcId]);
  return { id: r.insertId, name, ...lot, stock_qty: qty, status: STATUS_CUTTING };
}

async function updateRollStatus(conn, rollId) {
  const [rows] = await conn.query("SELECT remaining_length FROM fabric_rolls WHERE roll_id = ?", [rollId]);
  if (rows.length) {
    await conn.query("UPDATE fabric_rolls SET status = ? WHERE roll_id = ?", [
      rollStatusOf(rows[0].remaining_length), rollId,
    ]);
  }
}

/* =========================
   GET available rolls
========================= */
router.get("/rolls", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `${ROLL_SELECT} AND fr.remaining_length > 0 ORDER BY fr.roll_id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /fabric-calculator/rolls error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});

/* =========================
   PREVIEW calculation
========================= */
router.post("/preview", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const result = await computeCalculation(conn, req.body);
    res.json(result);
  } catch (err) {
    console.error("POST /fabric-calculator/preview error:", err);
    res.status(400).json({ message: err.message || "Server error" });
  } finally {
    conn.release();
  }
});

/* =========================
   COMMIT calculation + deduct stock
========================= */
router.post("/commit", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const computed = await computeCalculation(conn, req.body);

    if (computed.short_rolls.length) {
      await conn.rollback();
      return res.status(400).json({
        message: `ผ้าไม่พอ: ${computed.short_rolls.join(", ")} — ยังตัดผ้าไม่ได้`,
        preview: computed,
      });
    }

    // 1) รอบตัด: ต้นทุน + ราคาขาย
    const [sessionResult] = await conn.query(
      `INSERT INTO fabric_calc_sessions
       (product_type, qty, tailor_id, total_fabric_cost, total_cost, total_sell_price, price_per_piece, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        computed.product_type,
        computed.qty,
        computed.tailor_id,
        computed.total_fabric_cost,
        computed.total_cost,
        computed.total_sell_price,
        computed.price_per_piece,
        computed.note,
      ]
    );

    const calcId = sessionResult.insertId;

    // 2) ผ้าที่ใช้แต่ละชิ้น + บันทึกการใช้ผ้า + ตัดม้วนผ้า
    for (const item of computed.items) {
      await conn.query(
        `INSERT INTO fabric_calc_items (calc_id, roll_id, part_name, total_usage, cost_per_meter, total_cost)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [calcId, item.roll_id, item.part_name, item.total_usage, item.cost_per_meter, item.total_cost]
      );

      /* ลงบันทึกการใช้ผ้าด้วย จะได้เห็นในหน้ารายละเอียดม้วนเหมือนการตัดผ้าทางอื่น */
      await conn.query(
        `INSERT INTO fabric_usage_logs (roll_id, used_length, cost_per_meter, total_cost, remaining_after, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [item.roll_id, item.total_usage, item.cost_per_meter, item.total_cost, item.after_remaining,
          `รอบตัด #${calcId}: ${computed.product_type} ${computed.qty} ชุด (${item.part_name})`.slice(0, 250)]
      );

      await conn.query(
        "UPDATE fabric_rolls SET remaining_length = ? WHERE roll_id = ?",
        [item.after_remaining, item.roll_id]
      );

      await updateRollStatus(conn, item.roll_id);
    }

    /* ตัดเพื่อขายหน้าร้าน → เพิ่มเข้าคลังสินค้าเป็น "กำลังตัด" (ขายได้หลังกดตัดเสร็จ) */
    const product = req.body?.product ? await createProduct(conn, req.body.product, computed, calcId) : null;

    await conn.commit();

    res.json({
      message: product ? "ตัดผ้าออกจากคลังแล้ว สินค้าอยู่ในสถานะกำลังตัด" : "บันทึกและตัดผ้าออกจากคลังสำเร็จ",
      calc_id: calcId,
      product,
      result: computed,
    });
  } catch (err) {
    await conn.rollback();
    console.error("POST /fabric-calculator/commit error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  } finally {
    conn.release();
  }
});

/* =========================
   GET calculation history
========================= */
router.get("/history", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        s.calc_id,
        s.product_type,
        s.qty,
        s.total_fabric_cost,
        s.total_cost,
        s.price_per_piece AS sell_price_per_piece,
        s.total_sell_price,
        s.price_per_piece,
        s.tailor_id,
        u.name AS tailor_name,
        u.nickname AS tailor_nickname,
        s.product_id,
        p.status AS product_status,
        p.name AS product_name,
        p.lot_code AS product_lot_code,
        s.note,
        s.created_at
      FROM fabric_calc_sessions s
      LEFT JOIN users u ON u.id = s.tailor_id
      LEFT JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
      ORDER BY s.calc_id DESC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /fabric-calculator/history error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});

module.exports = router;
