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

const publicPath = (filename) => filename ? `/uploads/${filename}` : null;

router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM sizes'
        );
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM sizes WHERE size_id = ?',
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ message: 'Not found' });
        res.json(rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/', upload.single('image'), async (req, res) => {
    try {
        const { size_code, use_m } = req.body || {};

        const [result] = await pool.query(
            'INSERT INTO sizes (size_code, use_m) VALUES (?, ?)',
            [size_code, use_m]
        );

        res.status(201).json({
            size_id: result.insertId,
            size_code,
            use_m,
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/:id', upload.single('image'), async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;
        const { size_code = null, use_m = null } = req.body || {};

        const [result] = await conn.query(
            `UPDATE sizes
             SET size_code = COALESCE(?, size_code),
                 use_m = COALESCE(?, use_m)
             WHERE size_id = ?`,
            [size_code, use_m, id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'Not found' });
        }

        res.json({ message: 'Updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

router.put('/delete/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;

        const [result] = await conn.query(
            `UPDATE sizes
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE size_id = ?`,
            [id]
        );

        if (!result.affectedRows)
            return res.status(404).json({ message: 'Not found' });

        res.json({ message: 'Deleted' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

module.exports = router;
