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

// helper path (ไม่ได้ใช้จริง แต่คงโครงสร้างเดิม)
const publicPath = (filename) => filename ? `/uploads/${filename}` : null;


router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM Colors WHERE deleted_at IS NULL'
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
            `SELECT 
                id_colors,
                colors_name,
                colors_detail,
                created_at
             FROM Colors
             WHERE id_colors = ? AND deleted_at IS NULL`,
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

router.post('/', upload.single('image'), async (req, res) => {
    try {
        const { colors_name, colors_detail } = req.body || {};

        if (!colors_name) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'colors_name is required' });
        }

        const [result] = await pool.query(
            `INSERT INTO Colors (colors_name, colors_detail)
             VALUES (?, ?)`,
            [colors_name, colors_detail || null]
        );

        res.status(201).json({
            id_colors: result.insertId,
            colors_name,
            colors_detail
        });
    } catch (e) {
        console.error(e);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ message: 'Server error' });
    }
});


router.put('/:id', upload.single('image'), async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;
        const { colors_name = null, colors_detail = null } = req.body || {};

        const [result] = await conn.query(
            `UPDATE Colors
             SET colors_name   = COALESCE(?, colors_name),
                 colors_detail = COALESCE(?, colors_detail)
             WHERE id_colors = ?`,
            [colors_name, colors_detail, id]
        );

        if (!result.affectedRows)
            return res.status(404).json({ message: 'Not found or no change' });

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
            `UPDATE Colors
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE id_colors = ?`,
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
