const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM Employee WHERE deleted_at IS NULL'
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
                idEmployee,
                Emp_first_name,
                Emp_last_name,
                position,
                hire_date,
                Emp_status,
                created_at,
                updated_at
             FROM Employee
             WHERE idEmployee = ? AND deleted_at IS NULL`,
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

router.post('/', async (req, res) => {
    try {
        const {
            Emp_first_name,
            Emp_last_name,
            position,
            hire_date,
            Emp_status
        } = req.body || {};

        if (!Emp_first_name || !Emp_last_name || !position) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const [result] = await pool.query(
            `INSERT INTO Employee
            (Emp_first_name, Emp_last_name, position, hire_date, Emp_status)
            VALUES (?, ?, ?, ?, ?)`,
            [
                Emp_first_name,
                Emp_last_name,
                position,
                hire_date || new Date(),
                Emp_status || 'active'
            ]
        );

        res.status(201).json({
            idEmployee: result.insertId,
            Emp_first_name,
            Emp_last_name,
            position,
            Emp_status: Emp_status || 'active'
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/:id', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const id = req.params.id;

        const {
            Emp_first_name = null,
            Emp_last_name = null,
            position = null,
            Emp_status = null
        } = req.body || {};

        const [result] = await conn.query(
            `UPDATE Employee
             SET Emp_first_name = COALESCE(?, Emp_first_name),
                 Emp_last_name  = COALESCE(?, Emp_last_name),
                 position       = COALESCE(?, position),
                 Emp_status     = COALESCE(?, Emp_status)
             WHERE idEmployee = ? AND deleted_at IS NULL`,
            [Emp_first_name, Emp_last_name, position, Emp_status, id]
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
            `UPDATE Employee
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE idEmployee = ?`,
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
