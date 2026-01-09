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
      'SELECT * FROM Promotion'
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
      'SELECT * FROM Promotion WHERE idPromotion = ?',
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
      Promotion_details,
      promo_code,
      PER_ITEM
    } = req.body || {};

    const [result] = await pool.query(
      `INSERT INTO Promotion
      (Promotion_details, promo_code, PER_ITEM)
      VALUES (?, ?, ?)`,
      [Promotion_details, promo_code, PER_ITEM]
    );

    res.status(201).json({
      idPromotion: result.insertId,
      Promotion_details,
      promo_code,
      PER_ITEM,
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
    const {
      Promotion_details = null,
      promo_code = null,
      PER_ITEM = null
    } = req.body || {};

    const [result] = await conn.query(
      `UPDATE Promotion
       SET Promotion_details = COALESCE(?, Promotion_details),
           promo_code = COALESCE(?, promo_code),
           PER_ITEM = COALESCE(?, PER_ITEM)
       WHERE idPromotion = ?`,
      [Promotion_details, promo_code, PER_ITEM, id]
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
            `UPDATE Promotion
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE idPromotion = ?`,
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

