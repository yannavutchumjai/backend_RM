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
            'SELECT * FROM Detail_bill WHERE deleted_at IS NULL'
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
                idDetail_bill,
                Bill_idBill,
                Employee_idEmployee,
                Products_idProducts,
                Promotion_idPromotion,
                quantity,
                unit_price,
                discount_amount,
                notes,
                created_at
             FROM Detail_bill
             WHERE idDetail_bill = ? AND deleted_at IS NULL`,
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
            Bill_idBill,
            Employee_idEmployee,
            Products_idProducts,
            Promotion_idPromotion,
            quantity,
            unit_price,
            discount_amount,
            notes
        } = req.body || {};

        if (!Bill_idBill || !Employee_idEmployee || !Products_idProducts || quantity == null || unit_price == null) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const [result] = await pool.query(
            `INSERT INTO Detail_bill
            (Bill_idBill, Employee_idEmployee, Products_idProducts, Promotion_idPromotion,
             quantity, unit_price, discount_amount, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                Bill_idBill,
                Employee_idEmployee,
                Products_idProducts,
                Promotion_idPromotion || null,
                quantity,
                unit_price,
                discount_amount || 0,
                notes || null
            ]
        );

        res.status(201).json({
            idDetail_bill: result.insertId,
            Bill_idBill,
            quantity,
            unit_price
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
            Bill_idBill = null,
            Employee_idEmployee = null,
            Products_idProducts = null,
            Promotion_idPromotion = null,
            quantity = null,
            unit_price = null,
            discount_amount = null,
            notes = null
        } = req.body || {};

        const [result] = await conn.query(
            `UPDATE Detail_bill
             SET Bill_idBill           = COALESCE(?, Bill_idBill),
                 Employee_idEmployee   = COALESCE(?, Employee_idEmployee),
                 Products_idProducts   = COALESCE(?, Products_idProducts),
                 Promotion_idPromotion = COALESCE(?, Promotion_idPromotion),
                 quantity              = COALESCE(?, quantity),
                 unit_price            = COALESCE(?, unit_price),
                 discount_amount       = COALESCE(?, discount_amount),
                 notes                 = COALESCE(?, notes)
             WHERE idDetail_bill = ? AND deleted_at IS NULL`,
            [
                Bill_idBill,
                Employee_idEmployee,
                Products_idProducts,
                Promotion_idPromotion,
                quantity,
                unit_price,
                discount_amount,
                notes,
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
            `UPDATE Detail_bill
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE idDetail_bill = ?`,
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

