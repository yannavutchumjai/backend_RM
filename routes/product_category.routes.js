/* ═══════════════════════════════════════════════════════════
   PRODUCT CATEGORY — หมวดหมู่สินค้า
   แยกออกมาเป็นตารางของตัวเอง สินค้าอ้างด้วย category_id
   เปลี่ยนชื่อหมวดที่เดียว สินค้าทุกตัวเปลี่ยนตาม
═══════════════════════════════════════════════════════════ */

const express = require("express");
const router = express.Router();
const { pool } = require("../db");

const clean = (v) => String(v ?? "").trim();

/* GET /product-categories — พร้อมจำนวนสินค้าในแต่ละหมวด */
router.get("/", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT pc.category_id, pc.category_name, pc.sort_order,
              COUNT(p.id) AS product_count
       FROM product_category pc
       LEFT JOIN products p
              ON p.category_id = pc.category_id AND p.deleted_at IS NULL
       WHERE pc.deleted_at IS NULL
       GROUP BY pc.category_id, pc.category_name, pc.sort_order
       ORDER BY pc.sort_order, pc.category_id`
    );
    res.json(rows.map((r) => ({ ...r, product_count: Number(r.product_count) })));
  } catch (err) {
    console.error("GET categories:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* POST /product-categories — เพิ่มหมวดใหม่ */
router.post("/", async (req, res) => {
  const name = clean(req.body?.category_name);
  if (!name) return res.status(400).json({ message: "ต้องระบุชื่อหมวดหมู่" });
  if (name.length > 100) return res.status(400).json({ message: "ชื่อหมวดหมู่ยาวเกิน 100 ตัวอักษร" });

  try {
    /* เคยลบไปแล้วชื่อเดิม → เอากลับมาใช้ ไม่ชน UNIQUE */
    const [dup] = await pool.query(
      "SELECT category_id, deleted_at FROM product_category WHERE category_name = ? LIMIT 1",
      [name]
    );
    if (dup.length) {
      if (!dup[0].deleted_at) return res.status(409).json({ message: "มีหมวดหมู่ชื่อนี้อยู่แล้ว" });
      await pool.query(
        "UPDATE product_category SET deleted_at = NULL WHERE category_id = ?",
        [dup[0].category_id]
      );
      return res.status(201).json({ category_id: dup[0].category_id, category_name: name });
    }

    const [[m]] = await pool.query("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM product_category");
    const [r] = await pool.query(
      "INSERT INTO product_category (category_name, sort_order) VALUES (?, ?)",
      [name, m.n]
    );
    res.status(201).json({ category_id: r.insertId, category_name: name });
  } catch (err) {
    console.error("POST category:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* PUT /product-categories/:id — แก้ชื่อ */
router.put("/:id", async (req, res) => {
  const name = clean(req.body?.category_name);
  if (!name) return res.status(400).json({ message: "ต้องระบุชื่อหมวดหมู่" });

  try {
    const [r] = await pool.query(
      "UPDATE product_category SET category_name = ? WHERE category_id = ? AND deleted_at IS NULL",
      [name, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ message: "ไม่พบหมวดหมู่นี้" });
    res.json({ message: "Updated" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ message: "มีหมวดหมู่ชื่อนี้อยู่แล้ว" });
    console.error("PUT category:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* PUT /product-categories/delete/:id — ซ่อน (กันลบหมวดที่ยังมีสินค้าอยู่) */
router.put("/delete/:id", async (req, res) => {
  try {
    const [[c]] = await pool.query(
      "SELECT COUNT(*) n FROM products WHERE category_id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (c.n > 0) {
      return res.status(409).json({
        message: `ลบไม่ได้ ยังมีสินค้าอยู่ในหมวดนี้ ${c.n} รายการ — ย้ายสินค้าไปหมวดอื่นก่อน`,
      });
    }

    const [r] = await pool.query(
      "UPDATE product_category SET deleted_at = CURRENT_TIMESTAMP WHERE category_id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ message: "ไม่พบหมวดหมู่นี้" });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("DELETE category:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
