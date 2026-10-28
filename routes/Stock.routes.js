const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// กำหนดที่เก็บไฟล์
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// การตั้งค่า multer สำหรับอัปโหลดไฟล์
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, name);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },  // จำกัดขนาดไฟล์สูงสุดที่ 5MB
    fileFilter: (req, file, cb) => {
        const ok = /image\/(png|jpeg|jpg|webp|gif)/.test(file.mimetype);
        cb(ok ? null : new Error('Only image files are allowed'));
    },
});

const publicPath = (filename) => filename ? `/uploads/${filename}` : null;


router.get('/statuses_list', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT status_id, status_status FROM Status');
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Database Error' });
    }
});


// GET ข้อมูลทั้งหมดจาก Stock
router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.*, 
                c.category_name, 
                st.status_status 
            FROM stock s
            LEFT JOIN category c ON s.category_id = c.category_id 
            LEFT JOIN status st ON s.status_id = st.status_id
        `);
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET ข้อมูลสินค้าใน Stock โดยใช้ stock_id พร้อมสถานะ
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT 
                s.stock_id, 
                s.category_id, 
                s.status_id,
                s.stock_name, 
                s.stock_colors, -- เพิ่มฟิลด์สีที่ขาดไป
                s.price, 
                s.size, 
                s.unit, 
                s.stock_amount, 
                s.storage, 
                s.created_at, 
                s.updated_at, 
                s.deleted_at,
                c.category_name, 
                st.status_status
             FROM stock s
             LEFT JOIN category c ON s.category_id = c.category_id 
             LEFT JOIN status st ON s.status_id = st.status_id  
             WHERE s.stock_id = ?`,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ message: 'Not found' });
        res.json(rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST เพิ่มสินค้าใหม่ใน Stock
// POST เพิ่มสินค้าใหม่
router.post('/add_stock', async (req, res) => {
  try {
    const {
      category_id,
      stock_name,
      stock_colors,
      price,
      size,
      unit,
      stock_amount,
      storage,
      status_id
    } = req.body;

    // ตรวจสอบฟิลด์บังคับเบื้องต้น (ห้ามเป็น undefined)
    if (!stock_name) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อรายการ' });
    }

    const [result] = await pool.query(
      `INSERT INTO stock (
        category_id, stock_name, stock_colors, price, 
        size, unit, stock_amount, storage, status_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        category_id || 1,        // ถ้าว่างให้ใส่ 1 (ประเภทเริ่มต้น)
        stock_name,              // ห้ามว่าง
        stock_colors || "",      // ถ้าว่างใส่ข้อความว่าง
        price || 0,              // ต้องเป็นตัวเลข ห้ามว่าง
        size || "-",             // ห้ามว่าง
        unit || "ชิ้น",           // ห้ามว่าง
        stock_amount || 0,       // ห้ามว่าง
        storage || "ไม่ได้ระบุ",     // ห้ามว่าง
        status_id || 1           // ถ้าว่างให้ใส่ 1 (พร้อมใช้)
      ]
    );

    res.status(201).json({ message: 'เพิ่มข้อมูลสำเร็จ', id: result.insertId });
  } catch (e) {
    console.error("SQL Error:", e.message);
    res.status(500).json({ message: 'Server Error: ' + e.message });
  }
});

// PUT อัปเดตสินค้าใน Stock
router.put('/edit_stock/:id', upload.single('image'), async (req, res) => {
    const id = req.params.id;
    const {
        category_id,
        stock_name,
        stock_colors,
        price,
        size,
        unit,
        stock_amount,
        storage,
        status_id
    } = req.body;

    try {
        const [result] = await pool.query(
            `UPDATE stock
       SET category_id = COALESCE(?, category_id),
           stock_name = COALESCE(?, stock_name),
           stock_colors = COALESCE(?, stock_colors),
           price = COALESCE(?, price),
           size = COALESCE(?, size),
           unit = COALESCE(?, unit),
           stock_amount = COALESCE(?, stock_amount),
           storage = COALESCE(?, storage),
           status_id = COALESCE(?, status_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE stock_id = ?`,
            [
                category_id || null,
                stock_name || null,
                stock_colors || null,
                price !== undefined ? Number(price) : null,
                size || null,
                unit || null,
                stock_amount !== undefined ? Number(stock_amount) : null,
                storage || null,
                status_id || null,
                id
            ]
        );

        res.json({ message: 'Stock updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error: ' + e.message });
    }
});

// DELETE ลบสินค้าใน Stock
// DELETE ลบสินค้าใน Stock
router.delete('/delete_stock/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const [result] = await pool.query(
            `DELETE FROM stock WHERE stock_id = ?`,
            [id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'ไม่พบรายการสต็อกที่ต้องการลบ' });
        }

        res.json({ message: 'ลบรายการสต็อกเรียบร้อยแล้ว' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

module.exports = router;
