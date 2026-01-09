const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const path = require('path');
const fs = require('fs');
const { authRequired, requireRole } = require('../middlewares/auth');

const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

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
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = /image\/(png|jpeg|jpg|webp|gif)/.test(file.mimetype);
        cb(ok ? null : new Error('Only image files are allowed'));
    },
});

const publicPath = (filename) =>
    filename ? `/uploads/${filename}` : null;

router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM fabric_usage'
        );
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /fabric_usage/:id — รายการเดียว
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM fabric_usage WHERE usage_id = ?',
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

// POST /fabric_usage — เพิ่มใหม่
router.post('/', upload.single('image'), async (req, res) => {
    try {
        const { roll_id, size_id, qty, total_use_m, note } = req.body || {};

        const [result] = await pool.query(
            `INSERT INTO fabric_usage (roll_id, size_id, qty, total_use_m, note)
             VALUES (?, ?, ?, ?, ?)`,
            [roll_id, size_id, qty, total_use_m, note]
        );

        res.status(201).json({
            usage_id: result.insertId,
            roll_id,
            size_id,
            qty,
            total_use_m,
            note,
        });
    } catch (e) {
        console.error(e);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ message: e.message || 'Server error' });
    }
});

router.put('/:id', upload.single('image'), async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;

        const [oldRows] = await conn.query(
            'SELECT * FROM fabric_usage WHERE usage_id = ?',
            [id]
        );
        if (!oldRows.length)
            return res.status(404).json({ message: 'Not found' });

        const { roll_id, size_id, qty, total_use_m, note } = req.body || {};

        const [result] = await conn.query(
            `UPDATE fabric_usage
             SET roll_id = COALESCE(?, roll_id),
                 size_id = COALESCE(?, size_id),
                 qty = COALESCE(?, qty),
                 total_use_m = COALESCE(?, total_use_m),
                 note = COALESCE(?, note)
             WHERE usage_id = ?`,
            [roll_id, size_id, qty, total_use_m, note, id]
        );

        if (!result.affectedRows)
            return res.status(400).json({ message: 'No change' });

        res.json({ message: 'Updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

router.delete('/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;

        const [rows] = await conn.query(
            'SELECT * FROM fabric_usage WHERE usage_id = ?',
            [id]
        );
        if (!rows.length)
            return res.status(404).json({ message: 'Not found' });

        const [result] = await conn.query(
            'DELETE FROM fabric_usage WHERE usage_id = ?',
            [id]
        );
        if (!result.affectedRows)
            return res.status(400).json({ message: 'Delete failed' });

        res.json({ message: 'Deleted' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

module.exports = router;
