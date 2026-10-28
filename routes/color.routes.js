const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ===============================
// GET ALL COLORS
// ===============================
router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                color_id,
                color_name
            FROM Color
            WHERE deleted_at IS NULL
            ORDER BY color_id ASC
        `);
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// ===============================
// GET COLOR BY ID
// ===============================
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                color_id,
                color_name
            FROM Color
            WHERE color_id = ? AND deleted_at IS NULL
        `, [req.params.id]);

        if (!rows.length) {
            return res.status(404).json({ message: 'Not found' });
        }
        res.json(rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// ===============================
// CREATE COLOR
// ===============================
router.post('/', async (req, res) => {
    try {
        const { color_name } = req.body;

        if (!color_name) {
            return res.status(400).json({ message: 'color_name is required' });
        }

        const [[lastRow]] = await pool.query(`
            SELECT COALESCE(MAX(color_id), 0) AS last_id
            FROM Color
        `);

        const nextColorId = Number(lastRow?.last_id || 0) + 1;

        await pool.query(`
            INSERT INTO Color (color_id, color_name)
            VALUES (?, ?)
        `, [nextColorId, color_name]);

        res.status(201).json({
            color_id: nextColorId,
            color_name
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// ===============================
// UPDATE COLOR
// ===============================
router.put('/:id', async (req, res) => {
    try {
        const { color_name } = req.body;

        const [result] = await pool.query(`
            UPDATE Color
            SET color_name = COALESCE(?, color_name),
                updated_at = CURRENT_TIMESTAMP
            WHERE color_id = ? AND deleted_at IS NULL
        `, [color_name, req.params.id]);

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'Not found' });
        }
        res.json({ message: 'Updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// ===============================
// SOFT DELETE
// ===============================
router.delete('/:id', async (req, res) => {
    try {
        const [result] = await pool.query(`
            UPDATE Color
            SET deleted_at = CURRENT_TIMESTAMP
            WHERE color_id = ? AND deleted_at IS NULL
        `, [req.params.id]);

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'Not found' });
        }
        res.json({ message: 'Deleted' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;