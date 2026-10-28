const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ===============================
// GET ALL CATEGORIES
// ===============================
router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                category_id,
                category_name
            FROM category
            WHERE deleted_at IS NULL
            ORDER BY category_id ASC
        `);
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// ===============================
// GET CATEGORY BY ID
// ===============================
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                category_id,
                category_name
            FROM category
            WHERE category_id = ? AND deleted_at IS NULL
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
// CREATE CATEGORY
// ===============================
router.post('/', async (req, res) => {
    try {
        const { category_name } = req.body;

        if (!category_name) {
            return res.status(400).json({ message: 'category_name is required' });
        }

        const [result] = await pool.query(`
            INSERT INTO category (category_name)
            VALUES (?)
        `, [category_name]);

        res.status(201).json({
            category_id: result.insertId,
            category_name
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// ===============================
// UPDATE CATEGORY
// ===============================
router.put('/:id', async (req, res) => {
    try {
        const { category_name } = req.body;

        const [result] = await pool.query(`
            UPDATE category
            SET category_name = COALESCE(?, category_name),
                updated_at = CURRENT_TIMESTAMP
            WHERE category_id = ? AND deleted_at IS NULL
        `, [category_name, req.params.id]);

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
            UPDATE category
            SET deleted_at = CURRENT_TIMESTAMP
            WHERE category_id = ? AND deleted_at IS NULL
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