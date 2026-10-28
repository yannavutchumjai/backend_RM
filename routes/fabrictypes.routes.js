// routes/products.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const path = require('path');
const fs = require('fs');
const { authRequired, requireRole } = require('../middlewares/auth');

const multer = require('multer');

// โฟลเดอร์เก็บไฟล์ (ถ้ายังไม่มีให้สร้าง)
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// ตั้งชื่อไฟล์: <timestamp>-<random>.<ext>
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

// อนุญาตเฉพาะรูป + จำกัดขนาด 5MB
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpeg|jpg|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed'), ok);
  },
});

// helper: คืนเป็น path ที่ client เข้าถึงได้
const publicPath = (filename) =>
  filename ? `/uploads/${filename}` : null;

// ---------- CRUD ----------

// GET /fabric_types — ทั้งหมด
router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT type_id, type_name, image_path
       FROM fabric_types
       WHERE deleted_at IS NULL
       ORDER BY type_id ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /fabric_types/:id — รายการเดียว
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM fabric_types WHERE type_id = ?',
      [req.params.id]
    );
    if (!rows.length)
      return res.status(404).json({ message: 'Not found' });

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /fabric_types — เพิ่มใหม่
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { type_name } = req.body || {};
    if (!type_name) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: 'type_name is required' });
    }

    const imagePath = req.file ? publicPath(req.file.filename) : null;

    const [result] = await pool.query(
      'INSERT INTO fabric_types (type_name, image_path) VALUES (?, ?)',
      [type_name, imagePath]
    );

    res.status(201).json({
      type_id: result.insertId,
      type_name,
      image_path: imagePath,
    });
  } catch (e) {
    console.error(e);
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ message: e.message || 'Server error' });
  }
});

// PUT /fabric_types/:id — แก้ไข
router.put('/:id', upload.single('image'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;

    const [oldRows] = await conn.query(
      'SELECT * FROM fabric_types WHERE type_id = ?',
      [id]
    );
    if (!oldRows.length) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'Not found' });
    }

    const { type_name = null, removeImage } = req.body || {};
    const old = oldRows[0];

    const newImagePath = req.file
      ? publicPath(req.file.filename)
      : (removeImage === "true" ? null : old.image_path);

    const [result] = await conn.query(
      `UPDATE fabric_types
       SET type_name = COALESCE(?, type_name),
           image_path = ?
       WHERE type_id = ?`,
      [type_name, newImagePath, id]
    );

    if (newImagePath !== old.image_path && old.image_path) {
      const oldFilePath = path.join(UPLOAD_DIR, path.basename(old.image_path));
      if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
    }

    if (!result.affectedRows)
      return res.status(400).json({ message: 'No change' });

    res.json({ message: 'Updated', image_path: newImagePath });
  } catch (e) {
    console.error(e);
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// DELETE /fabric_types/:id — ลบ
// ✅ DELETE — เปลี่ยนเป็น soft delete
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.query(
      `UPDATE fabric_types 
       SET deleted_at = CURRENT_TIMESTAMP 
       WHERE type_id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.affectedRows)
      return res.status(404).json({ message: 'Not found' });

    res.json({ message: 'Deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
