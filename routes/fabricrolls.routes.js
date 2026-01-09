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
            'SELECT * FROM fabric_rolls'
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
                roll_id,
                roll_code,
                type_id,
                name,
                price_per_m,
                stock_m,
                created_at
             FROM fabric_rolls
             WHERE roll_id = ?`,
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
        const {
            roll_code,
            type_id,
            name,
            price_per_m,
            stock_m
        } = req.body || {};

        if (!roll_code || !type_id || !name || price_per_m == null || stock_m == null) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const [result] = await pool.query(
            `INSERT INTO fabric_rolls
            (roll_code, type_id, name, price_per_m, stock_m)
            VALUES (?, ?, ?, ?, ?)`,
            [
                roll_code,
                type_id,
                name,
                price_per_m,
                stock_m
            ]
        );

        res.status(201).json({
            roll_id: result.insertId,
            roll_code,
            name,
            stock_m
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

        const {
            roll_code = null,
            type_id = null,
            name = null,
            price_per_m = null,
            stock_m = null
        } = req.body || {};

        const [result] = await conn.query(
            `UPDATE fabric_rolls
             SET roll_code   = COALESCE(?, roll_code),
                 type_id     = COALESCE(?, type_id),
                 name        = COALESCE(?, name),
                 price_per_m = COALESCE(?, price_per_m),
                 stock_m     = COALESCE(?, stock_m)
             WHERE roll_id = ?`,
            [
                roll_code,
                type_id,
                name,
                price_per_m,
                stock_m,
                id
            ]
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
            `UPDATE fabric_rolls
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE roll_id = ?`,
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

