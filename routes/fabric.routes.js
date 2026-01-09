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
            'SELECT * FROM Fabric WHERE deleted_at IS NULL'
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
                idFabric,
                name_f,
                width_cm,
                weight_gm,
                thickness_mm,
                image_f,
                status_f,
                created_at
             FROM Fabric
             WHERE idFabric = ? AND deleted_at IS NULL`,
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
            name_f,
            width_cm,
            weight_gm,
            thickness_mm,
            status_f
        } = req.body || {};

        if (!name_f || !width_cm || !weight_gm) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const imagePath = req.file ? publicPath(req.file.filename) : null;

        const [result] = await pool.query(
            `INSERT INTO Fabric
            (name_f, width_cm, weight_gm, thickness_mm, image_f, status_f)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [
                name_f,
                width_cm,
                weight_gm,
                thickness_mm,
                imagePath,
                status_f || 'พร้อมใช้'
            ]
        );

        res.status(201).json({
            idFabric: result.insertId,
            name_f,
            width_cm,
            weight_gm,
            thickness_mm,
            image_f: imagePath,
            status_f: status_f || 'พร้อมใช้'
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

        const [oldRows] = await conn.query(
            'SELECT image_f FROM Fabric WHERE idFabric = ?',
            [id]
        );

        if (!oldRows.length) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ message: 'Not found' });
        }

        const {
            name_f = null,
            width_cm = null,
            weight_gm = null,
            thickness_mm = null,
            status_f = null
        } = req.body || {};

        const newImagePath = req.file ? publicPath(req.file.filename) : null;

        const [result] = await conn.query(
            `UPDATE Fabric
             SET name_f = COALESCE(?, name_f),
                 width_cm = COALESCE(?, width_cm),
                 weight_gm = COALESCE(?, weight_gm),
                 thickness_mm = COALESCE(?, thickness_mm),
                 image_f = COALESCE(?, image_f),
                 status_f = COALESCE(?, status_f)
             WHERE idFabric = ?`,
            [
                name_f,
                width_cm,
                weight_gm,
                thickness_mm,
                newImagePath,
                status_f,
                id
            ]
        );

        if (result.affectedRows && newImagePath && oldRows[0].image_f) {
            const oldFile = path.join(UPLOAD_DIR, path.basename(oldRows[0].image_f));
            if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        }

        res.json({ message: 'Updated' });
    } catch (e) {
        console.error(e);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
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
            `UPDATE Fabric
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE idFabric = ?`,
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

