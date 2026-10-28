/* ═══════════════════════════════════════════════════════════
   OUTFIT FORMULA — แบบชุด (ใช้โดยหน้าคำนวณราคาชุด / จัดการแบบชุด)
   เก็บ: ชื่อชุด + ชิ้นส่วนชุด (ชื่ออย่างเดียว เช่น เสื้อ / ผ้าถุง / สไบ)
   จุดวัดตัวเหมือนกันทุกชุด และร้านกรอกผ้าที่ใช้เป็นเมตรเอง
   จึงไม่เก็บสูตรผ้า/จุดวัดของแต่ละแบบแล้ว · ไม่มีค่าแรง
   ชิ้นส่วนใช้เป็น "ส่วนประกอบชุด" ของสินค้าที่ตัดจากแบบนี้

   mount: /outfit-formula และ /api/outfit-formulas (ชื่อที่หน้าเว็บเรียก)
═══════════════════════════════════════════════════════════ */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const shape = (f, parts) => ({
  formula_id: f.formula_id,
  outfit_name: f.outfit_name,
  sort_order: f.sort_order,
  parts: parts.map((p) => ({ part_id: p.part_id, part_name: p.part_name, sort_order: p.sort_order })),
});

/* หน้าเว็บส่ง { outfitName, parts:[{ name }], sortOrder } — รับชื่อเดิม outfit_name / part_name ด้วย */
function normalize(body = {}) {
  return {
    name: String(body.outfitName ?? body.outfit_name ?? '').trim(),
    sortOrder: body.sortOrder ?? body.sort_order,
    /* ไม่ส่ง parts มา = ไม่แตะชิ้นส่วนเดิม */
    partsGiven: Array.isArray(body.parts),
    parts: (Array.isArray(body.parts) ? body.parts : [])
      .map((p) => String((typeof p === 'string' ? p : p?.name ?? p?.part_name) ?? '').trim())
      .filter(Boolean),
  };
}

/* ── ตรวจข้อมูลก่อนบันทึก ── */
function validate(f) {
  if (!f.name) return 'ต้องระบุชื่อแบบชุด';
  if (f.name.length > 150) return 'ชื่อแบบชุดยาวเกิน 150 ตัวอักษร';
  const long = f.parts.find((p) => p.length > 120);
  if (long) return `ชื่อชิ้นส่วน "${long.slice(0, 20)}..." ยาวเกิน 120 ตัวอักษร`;
  return null;
}

async function insertParts(conn, formulaId, parts) {
  for (let i = 0; i < parts.length; i++) {
    await conn.query(
      'INSERT INTO outfit_formula_part (formula_id, part_name, sort_order) VALUES (?,?,?)',
      [formulaId, parts[i], i + 1]
    );
  }
}

/* GET — รายการทั้งหมดพร้อมชิ้นส่วน */
router.get('/', async (_req, res) => {
  try {
    const [formulas] = await pool.query(
      'SELECT * FROM outfit_formula WHERE deleted_at IS NULL ORDER BY sort_order, formula_id'
    );
    if (!formulas.length) return res.json([]);

    const ids = formulas.map((f) => f.formula_id);
    const [parts] = await pool.query(
      'SELECT * FROM outfit_formula_part WHERE formula_id IN (?) ORDER BY formula_id, sort_order, part_id',
      [ids]
    );

    res.json(formulas.map((f) => shape(f, parts.filter((p) => p.formula_id === f.formula_id))));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'โหลดแบบชุดไม่สำเร็จ' });
  }
});

/* POST — เพิ่มแบบชุดใหม่ */
router.post('/', async (req, res) => {
  const f = normalize(req.body);
  const bad = validate(f);
  if (bad) return res.status(400).json({ message: bad });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      'INSERT INTO outfit_formula (outfit_name, sort_order) VALUES (?,?)',
      [f.name, Number(f.sortOrder) || 99]
    );
    await insertParts(conn, r.insertId, f.parts);

    await conn.commit();
    res.status(201).json({ formula_id: r.insertId, outfit_name: f.name });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ message: 'มีแบบชุดชื่อนี้อยู่แล้ว' });
    console.error(e);
    res.status(500).json({ message: 'เพิ่มแบบชุดไม่สำเร็จ' });
  } finally {
    conn.release();
  }
});

/* PUT /:id — แก้ไข  ลำดับไม่ได้ส่งมาให้คงค่าเดิม
   ชิ้นส่วนเขียนใหม่ทั้งชุดเฉพาะเมื่อส่ง parts มา */
router.put('/:id', async (req, res) => {
  const f = normalize(req.body);
  const bad = validate(f);
  if (bad) return res.status(400).json({ message: bad });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const id = req.params.id;

    const [r] = await conn.query(
      `UPDATE outfit_formula
       SET outfit_name = ?, sort_order = COALESCE(?, sort_order)
       WHERE formula_id = ? AND deleted_at IS NULL`,
      [f.name, f.sortOrder != null ? Number(f.sortOrder) : null, id]
    );

    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ message: 'ไม่พบแบบชุดนี้' });
    }

    if (f.partsGiven) {
      await conn.query('DELETE FROM outfit_formula_part WHERE formula_id = ?', [id]);
      await insertParts(conn, id, f.parts);
    }

    await conn.commit();
    res.json({ message: 'Updated' });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ message: 'มีแบบชุดชื่อนี้อยู่แล้ว' });
    console.error(e);
    res.status(500).json({ message: 'แก้ไขแบบชุดไม่สำเร็จ' });
  } finally {
    conn.release();
  }
});

/* ลบ = ซ่อนออกจากรายการ (ข้อมูลยังอยู่) — หน้าเว็บใช้ DELETE, คง PUT /delete/:id เดิมไว้ */
async function softDelete(req, res) {
  try {
    const [r] = await pool.query(
      'UPDATE outfit_formula SET deleted_at = CURRENT_TIMESTAMP WHERE formula_id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ message: 'ไม่พบแบบชุดนี้' });
    res.json({ message: 'Deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'ลบแบบชุดไม่สำเร็จ' });
  }
}

router.delete('/:id', softDelete);
router.put('/delete/:id', softDelete);

module.exports = router;
