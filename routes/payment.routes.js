// routes/products.routes.js
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

const upload = multer({ storage });

const publicPath = (filename) =>
    filename ? `/uploads/${filename}` : null;

router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM Payment'
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
            'SELECT * FROM Payment WHERE id_payment = ?',
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
        const { Payment_type } = req.body || {};

        const [result] = await pool.query(
            'INSERT INTO Payment (Payment_type) VALUES (?)',
            [Payment_type]
        );

        res.status(201).json({
            id_payment: result.insertId,
            Payment_type,
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
        const { Payment_type } = req.body || {};

        const [result] = await conn.query(
            `UPDATE Payment
             SET Payment_type = COALESCE(?, Payment_type)
             WHERE id_payment = ?`,
            [Payment_type, id]
        );

        if (!result.affectedRows)
            return res.status(404).json({ message: 'Not found' });

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
            `UPDATE Payment
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE id_payment = ?`,
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

