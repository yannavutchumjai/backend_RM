const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const path = require('path');
const fs = require('fs');
const { authRequired, requireRole } = require('../middlewares/auth');

// ---------- Multer config ----------
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
        cb(ok ? null : new Error('Only image files are allowed'));
    },
});

// helper: คืนเป็น path ที่ client เข้าถึงได้
const publicPath = (filename) => filename ? `/uploads/${filename}` : null;

// ---------- CRUD ----------

// GET /users — ทั้งหมด
router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM users'
        );
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /users/:id — รายการเดียว
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, price, image, created_at FROM users WHERE id = ?',
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ message: 'Not found' });
        res.json(rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /users — สร้างใหม่
router.post('/', upload.single('image'), async (req, res) => {
    try {
        const { name, price } = req.body || {};
        if (!name || price == null) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'name & price are required' });
        }

        const imagePath = req.file ? publicPath(req.file.filename) : null;

        const [result] = await pool.query(
            'INSERT INTO users (name, price, image) VALUES (?, ?, ?)',
            [name, Number(price), imagePath]
        );

        res.status(201).json({
            id: result.insertId,
            name,
            price: Number(price),
            image: imagePath,
        });
    } catch (e) {
        console.error(e);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ message: e.message || 'Server error' });
    }
});

// PUT /users/:id — อัปเดต
router.put('/:id', upload.single('image'), async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;

        const [oldRows] = await conn.query(
            'SELECT image FROM users WHERE id = ?',
            [id]
        );
        if (!oldRows.length) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ message: 'Not found' });
        }

        const { name = null, price = null } = req.body || {};
        const newImagePath = req.file ? publicPath(req.file.filename) : null;

        const [result] = await conn.query(
            `UPDATE users
             SET name = COALESCE(?, name),
                 price = COALESCE(?, price),
                 image = COALESCE(?, image)
             WHERE id = ?`,
            [
                name,
                price != null ? Number(price) : null,
                newImagePath,
                id,
            ]
        );

        if (result.affectedRows && newImagePath && oldRows[0]?.image) {
            const oldFile = path.join(UPLOAD_DIR, path.basename(oldRows[0].image));
            if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        }

        if (!result.affectedRows) return res.status(400).json({ message: 'No change' });
        res.json({ message: 'Updated' });
    } catch (e) {
        console.error(e);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

// DELETE /users/:id — ลบ
router.delete('/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;
        const [rows] = await conn.query(
            'SELECT image FROM users WHERE id = ?',
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: 'Not found' });

        const [result] = await conn.query(
            'DELETE FROM users WHERE id = ?',
            [id]
        );
        if (!result.affectedRows) return res.status(400).json({ message: 'Delete failed' });

        if (rows[0].image) {
            const oldFile = path.join(UPLOAD_DIR, path.basename(rows[0].image));
            if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        }

        res.json({ message: 'Deleted' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

module.exports = router;
