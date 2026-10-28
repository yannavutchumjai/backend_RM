/* ═══════════════════════════════════════════════════════════════
   สินค้า (ตาราง products)
   - POST เพิ่มตรงได้เฉพาะ "สินค้ารับมาขาย" (source = resale) ต้องบอกว่ารับมาจากที่ไหน
   - สินค้าที่ร้านตัดเอง (source = made) เกิดจาก /api/fabric-calculator/commit เท่านั้น
     ชื่อ = ชื่อแบบชุด + เลขล็อต · เริ่มที่ "กำลังตัด"
     → PUT /:id/finish-cutting พร้อมช่วงขนาดชุด เมื่อตัดเสร็จ จึงเป็น "พร้อมขาย"
   - ช่วงขนาดชุด (size_ranges) ดู utils/productSizes.js
   ดูกติกาจำนวนคงเหลือใน utils/productStock.js
═══════════════════════════════════════════════════════════════ */
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { assignLot } = require("../lib/productLots");
const { cleanRanges, saveRanges, rangesByProduct } = require("../lib/productSizes");
const {
  STOCK_COLUMNS, withStock, stockOf, adjustFor,
  SOURCE_MADE, SOURCE_RESALE, STATUS_READY, STATUS_OFF, STATUS_CUTTING,
} = require("../lib/productStock");

/* จำนวนในคลังจากฟอร์ม — ว่าง/ไม่ส่งมา = null (ไม่แตะจำนวนเดิม) */
const qtyOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const text = (v, max) => String(v ?? "").trim().slice(0, max) || null;

/* สถานะที่ตั้งเองได้ในฟอร์ม — "กำลังตัด" เปลี่ยนได้ทางปุ่มตัดเสร็จเท่านั้น */
const formStatus = (v) => (v === STATUS_OFF ? STATUS_OFF : STATUS_READY);

/* หมวดหมู่: category_id (ตาราง product_category) + ชื่อใน products.category
   หน้าคลังสินค้าส่งมาเป็นชื่อ (category) ส่วนบางที่ส่ง category_id — คืนทั้ง id และชื่อ */
async function resolveCategory(body) {
  const id = Number(body.category_id) || null;
  if (id) {
    const [rows] = await pool.query(
      "SELECT category_id, category_name FROM product_category WHERE category_id = ? AND deleted_at IS NULL LIMIT 1",
      [id]
    );
    return { id: rows[0]?.category_id || null, name: rows[0]?.category_name || null };
  }
  const name = String(body.category || "").trim();
  if (!name) return { id: null, name: null };
  const [rows] = await pool.query(
    "SELECT category_id FROM product_category WHERE category_name = ? AND deleted_at IS NULL LIMIT 1",
    [name]
  );
  return { id: rows[0]?.category_id || null, name: name.slice(0, 100) };
}

/* ชื่อหมวดหมู่ส่งให้หน้าเว็บในชื่อ category เหมือนเดิม */
const PRODUCT_SELECT = `
  SELECT p.*, COALESCE(pc.category_name, p.category) AS category_name,
         COALESCE(pc.category_name, p.category) AS category, ${STOCK_COLUMNS}
    FROM products p
    LEFT JOIN product_category pc ON pc.category_id = p.category_id`;
const multer = require("multer");
const path = require("path");
const fs = require("fs");

/* ===================================================
   📁 UPLOAD DIRECTORY SETUP
=================================================== */
const uploadDir = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* ===================================================
   📸 MULTER CONFIGURATION
=================================================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

/* ลบรูปที่เพิ่งอัปโหลด เมื่อบันทึกไม่ผ่าน */
const dropUpload = (req) => {
  if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
};

/* ===================================================
   🟢 GET ALL PRODUCTS
=================================================== */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `${PRODUCT_SELECT}
       WHERE p.deleted_at IS NULL
       ORDER BY p.created_at DESC`
    );
    const sizes = await rangesByProduct(pool, rows.map((r) => r.id));
    res.json(rows.map((r) => ({ ...withStock(r), size_ranges: sizes[r.id] || [] })));
  } catch (err) {
    console.error("GET ALL ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});


/* ยอดที่ขายไปจริงของสินค้าแต่ละล็อต — นับเฉพาะบิลที่ยังไม่ถูกยกเลิก */
const SOLD_COLUMNS = `
  (SELECT COALESCE(SUM(d.quantity), 0)
     FROM Detail_bill d
     JOIN Bill b ON b.idBill = d.Bill_idBill AND b.deleted_at IS NULL
    WHERE d.Products_idProducts = p.id AND d.deleted_at IS NULL) AS sold_qty,
  (SELECT COALESCE(SUM(d.quantity * d.unit_price - COALESCE(d.discount_amount, 0)), 0)
     FROM Detail_bill d
     JOIN Bill b ON b.idBill = d.Bill_idBill AND b.deleted_at IS NULL
    WHERE d.Products_idProducts = p.id AND d.deleted_at IS NULL) AS sold_amount
`;

/* ===================================================
   🟢 PRODUCT SIZES — ตัวเลือกไซส์ของ dropdown
   ต้องประกาศก่อน "/:id" ไม่งั้น "sizes" จะถูกจับเป็น id
=================================================== */
router.get("/sizes", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT size_id, size_name FROM product_sizes ORDER BY sort_order ASC, size_name ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET SIZES ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* เพิ่มไซส์ใหม่จาก dropdown ในหน้าเพิ่มสินค้าได้เลย */
router.post("/sizes", async (req, res) => {
  try {
    const sizeName = String(req.body?.size_name || "").trim();
    if (!sizeName) return res.status(400).json({ message: "กรุณากรอกชื่อไซส์" });
    if (sizeName.length > 50) return res.status(400).json({ message: "ชื่อไซส์ยาวเกินไป" });

    const [[exists]] = await pool.query(
      "SELECT size_id, size_name FROM product_sizes WHERE LOWER(TRIM(size_name)) = ? LIMIT 1",
      [sizeName.toLowerCase()]
    );
    if (exists) return res.json({ ...exists, message: "มีไซส์นี้อยู่แล้ว" });

    const [result] = await pool.query(
      "INSERT INTO product_sizes (size_name, sort_order) VALUES (?, 100)",
      [sizeName]
    );
    res.status(201).json({ size_id: result.insertId, size_name: sizeName });
  } catch (err) {
    console.error("CREATE SIZE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟢 PRODUCT CATEGORIES — ตัวเลือก "ประเภท" ของ dropdown
   ต้องประกาศก่อน "/:id" เช่นเดียวกับ /sizes
=================================================== */
router.get("/categories", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT category_id, category_name FROM product_category
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, category_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET CATEGORIES ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* เพิ่มประเภทใหม่จาก dropdown ในหน้าเพิ่มสินค้าได้เลย */
router.post("/categories", async (req, res) => {
  try {
    const name = String(req.body?.category_name || "").trim();
    if (!name) return res.status(400).json({ message: "กรุณากรอกชื่อประเภท" });
    if (name.length > 100) return res.status(400).json({ message: "ชื่อประเภทยาวเกินไป" });

    const [[exists]] = await pool.query(
      `SELECT category_id, category_name FROM product_category
        WHERE deleted_at IS NULL AND LOWER(TRIM(category_name)) = ? LIMIT 1`,
      [name.toLowerCase()]
    );
    if (exists) return res.json({ ...exists, message: "มีประเภทนี้อยู่แล้ว" });

    const [[maxRow]] = await pool.query(
      "SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM product_category"
    );
    const [result] = await pool.query(
      "INSERT INTO product_category (category_name, sort_order) VALUES (?, ?)",
      [name, Number(maxRow.max_sort) + 1]
    );
    res.status(201).json({ category_id: result.insertId, category_name: name });
  } catch (err) {
    console.error("CREATE CATEGORY ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟢 ล็อตทั้งชุดของสินค้าตัวนี้ + ยอดขายของแต่ละล็อต
=================================================== */
router.get("/:id/lots", async (req, res) => {
  try {
    const [[base]] = await pool.query(
      "SELECT id, group_no FROM products WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (!base) return res.status(404).json({ message: "Product not found" });

    const groupNo = base.group_no || base.id;
    const [rows] = await pool.query(
      `SELECT p.*, ${SOLD_COLUMNS}
         FROM products p
        WHERE p.deleted_at IS NULL AND COALESCE(p.group_no, p.id) = ?
        ORDER BY p.lot_no ASC`,
      [groupNo]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET LOTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟢 ประวัติการขายจริงของสินค้าล็อตนี้ (ขายไปเท่าไหร่บ้าง)
=================================================== */
router.get("/:id/sales", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.idBill, b.Bill_details AS bill_no, b.created_at,
              b.customer_name, b.customer_phone,
              d.quantity, d.unit_price, COALESCE(d.discount_amount, 0) AS discount_amount,
              (d.quantity * d.unit_price - COALESCE(d.discount_amount, 0)) AS line_total
         FROM Detail_bill d
         JOIN Bill b ON b.idBill = d.Bill_idBill AND b.deleted_at IS NULL
        WHERE d.Products_idProducts = ? AND d.deleted_at IS NULL
        ORDER BY b.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET SALES ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟢 GET PRODUCT BY ID
=================================================== */
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `${PRODUCT_SELECT}
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    const sizes = await rangesByProduct(pool, [rows[0].id]);
    res.json({ ...withStock(rows[0]), size_ranges: sizes[rows[0].id] || [] });
  } catch (err) {
    console.error("GET BY ID ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟢 CREATE PRODUCT — สินค้ารับมาขายเท่านั้น
   ชุดที่ร้านตัดเองต้องผ่านหน้าคำนวณผ้า → ตั้งราคาขาย → ตัดเสร็จ
=================================================== */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { name, pattern, size, price, description, cost, status, stock_qty, supplier_name } = req.body;

    if (req.body.source && req.body.source !== SOURCE_RESALE) {
      dropUpload(req);
      return res.status(400).json({
        message: "ชุดที่ร้านตัดเองเพิ่มตรงไม่ได้ — ต้องคำนวณผ้าและตัดให้เสร็จก่อน จึงจะเป็นสินค้า",
      });
    }

    if (!name || !price) {
      dropUpload(req);
      return res.status(400).json({ message: "กรุณากรอกชื่อสินค้าและราคา" });
    }

    const supplier = text(supplier_name, 255);
    if (!supplier) {
      dropUpload(req);
      return res.status(400).json({ message: "กรุณาระบุว่ารับสินค้ามาจากที่ไหน" });
    }

    /* สินค้ารับมาขายใหม่ยังไม่มีที่ขาย จึงเก็บจำนวนรับเข้าตรง ๆ ได้ */
    const stockAdjust = qtyOrNull(stock_qty);
    if (stockAdjust === null) {
      dropUpload(req);
      return res.status(400).json({ message: "กรุณากรอกจำนวนที่รับเข้า (ตั้งแต่ 0 ชิ้นขึ้นไป)" });
    }

    const image = req.file ? req.file.filename : null;
    const { id: categoryId, name: categoryName } = await resolveCategory(req.body);

    const [result] = await pool.query(
      `INSERT INTO products
      (name, pattern, size, price, description, cost, category_id, category, status,
       source, supplier_name, image, stock_adjust)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        pattern || null,
        size || null,
        Number(price),
        description || null,
        Number(cost) || 0,
        categoryId,
        categoryName,
        formStatus(status),
        SOURCE_RESALE,
        supplier,
        image,
        stockAdjust,
      ]
    );
    /* สินค้าเหมือนกันแต่ราคาต่างกัน → ต่อเป็นล็อตถัดไปของชุดเดิม */
    const lot = await assignLot(pool, result.insertId, { name, category_id: categoryId });

    res.status(201).json({
      message: "Product created successfully",
      id: result.insertId,
      ...lot,
    });
  } catch (err) {
    console.error("CREATE ERROR:", err);
    dropUpload(req);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟢 ตัดเสร็จ — ชุดที่ร้านตัดเองจาก "กำลังตัด" เป็น "พร้อมขาย"
   ต้องส่งช่วงขนาดชุดมาด้วย: { sizes: [{ field_key, field_label, min_cm, max_cm }] }
=================================================== */
router.put("/:id/finish-cutting", async (req, res) => {
  const { rows, error } = cleanRanges(req.body?.sizes);
  if (error) return res.status(400).json({ message: error });
  if (!rows.length) {
    return res.status(400).json({ message: "กรอกขนาดชุดอย่างน้อย 1 จุดวัด (ใส่ได้ตั้งแต่–ถึง)" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `UPDATE products SET status = ?
        WHERE id = ? AND deleted_at IS NULL AND source = ? AND status = ?`,
      [STATUS_READY, req.params.id, SOURCE_MADE, STATUS_CUTTING]
    );
    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(400).json({ message: "สินค้านี้ไม่ได้อยู่ในสถานะกำลังตัด" });
    }
    const size = await saveRanges(conn, req.params.id, rows);
    await conn.commit();
    res.json({ message: "ตัดเสร็จแล้ว สินค้าพร้อมขาย", status: STATUS_READY, size });
  } catch (err) {
    await conn.rollback();
    console.error("FINISH CUTTING ERROR:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    conn.release();
  }
});

/* ===================================================
   🟢 แก้ช่วงขนาดชุด (หลังตัดเสร็จแล้ว หรือสินค้ารับมาขายก็ใส่ได้)
=================================================== */
router.put("/:id/sizes", async (req, res) => {
  const { rows, error } = cleanRanges(req.body?.sizes);
  if (error) return res.status(400).json({ message: error });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query("SELECT id FROM products WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!p) {
      await conn.rollback();
      return res.status(404).json({ message: "Product not found" });
    }
    const size = await saveRanges(conn, req.params.id, rows);
    await conn.commit();
    res.json({ message: "บันทึกขนาดชุดแล้ว", size });
  } catch (err) {
    await conn.rollback();
    console.error("SAVE SIZES ERROR:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    conn.release();
  }
});

/* ===================================================
   🟢 UPDATE PRODUCT
   ชุดที่ร้านตัดเอง: ต้นทุน/จำนวน มาจากการตัด แก้จากหน้านี้ไม่ได้
   และยังตัดไม่เสร็จก็ตั้งพร้อมขายเองไม่ได้
=================================================== */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { name, pattern, size, price, description, cost, status, stock_qty, supplier_name } = req.body;

    const [rows] = await pool.query(
      `SELECT p.*, pc.category_name
       FROM products p
       LEFT JOIN product_category pc ON pc.category_id = p.category_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );

    if (!rows.length) {
      dropUpload(req);
      return res.status(404).json({ message: "Product not found" });
    }

    const old = rows[0];
    const isMade = old.source === SOURCE_MADE;

    if (!name || !price) {
      dropUpload(req);
      return res.status(400).json({ message: "กรุณากรอกชื่อสินค้าและราคา" });
    }

    const supplier = isMade ? null : text(supplier_name, 255) || old.supplier_name;

    let image = old.image;

    if (req.file) {
      image = req.file.filename;
//ลบรูปเก่าออกจากเครื่อง
      if (old.image) {
        const oldPath = path.join(uploadDir, old.image);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    }

    const finalStatus = old.status === STATUS_CUTTING ? STATUS_CUTTING : formStatus(status);
    /* ชุดที่ตัดเอง: ไซส์มาจากช่วงขนาดที่กรอกตอนตัดเสร็จ (แก้ผ่าน PUT /:id/sizes) */
    const finalSize = isMade ? old.size : size || null;
    const finalCost = isMade ? old.cost : Number(cost) || 0;
    const { id: categoryId, name: categoryName } = await resolveCategory(req.body);

    /* สินค้ารับมาขาย: ฟอร์มส่ง "คงเหลือที่ต้องการ" มา → แปลงเป็น stock_adjust โดยหักที่ขายไปแล้ว
       ไม่ส่งมา / ชุดที่ตัดเอง = คงจำนวนเดิม */
    const target = isMade ? null : qtyOrNull(stock_qty);
    let stockAdjust = old.stock_adjust;
    if (target !== null) {
      const current = await stockOf(pool, req.params.id);
      stockAdjust = adjustFor(current, target);
    }

    await pool.query(
      `UPDATE products SET
        name = ?,
        pattern = ?,
        size = ?,
        price = ?,
        description = ?,
        cost = ?,
        category_id = ?,
        category = ?,
        status = ?,
        supplier_name = ?,
        image = ?,
        stock_adjust = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [
        name,
        pattern || null,
        finalSize,
        Number(price),
        description || null,
        finalCost,
        categoryId,
        categoryName,
        finalStatus,
        supplier,
        image,
        stockAdjust,
        req.params.id,
      ]
    );
    /* จัดล็อตใหม่เฉพาะเมื่อตัวตนสินค้าเปลี่ยน (ชื่อ/หมวด) — แก้แค่ราคา ลาย หรือไซส์ไม่ต้องเลื่อนเลขล็อต */
    const norm = (v) => String(v ?? "").trim().toLowerCase();
    const identityChanged = [
      [old.name, name], [old.category_id, categoryId], [old.category, categoryName],
    ].some(([a, b]) => norm(a) !== norm(b));
    const lot = identityChanged
      ? await assignLot(pool, Number(req.params.id), { name, category_id: categoryId })
      : { group_no: old.group_no, lot_no: old.lot_no, lot_code: old.lot_code };

    res.json({ message: "Product updated successfully", ...lot });
  } catch (err) {
    console.error("UPDATE ERROR:", err);
    dropUpload(req);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
   🟡 SOFT DELETE PRODUCT
=================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id FROM products WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    await pool.query(
      "UPDATE products SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );

    res.json({ message: "Product deleted successfully (soft delete)" });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
