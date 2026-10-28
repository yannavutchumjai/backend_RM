const express = require('express');
const router = express.Router();
const { pool } = require('../db');

///////////////////////////////////////////////////////
//// 1. GET ALL FABRICS (ดึงข้อมูลพร้อมชื่อ Type, Category และ Color)
///////////////////////////////////////////////////////
router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query(`
        SELECT 
            f.fabric_id,
            f.fabric_name,
            f.width_cm,
            f.image_path,
            f.status,
            f.created_at,
            ft.type_name,       -- ข้อมูลจากตาราง fabric_types
            c.category_name,    -- ข้อมูลจากตาราง category
            col.color_name      -- ข้อมูลจากตาราง Color
        FROM fabrics f
        LEFT JOIN fabric_types ft ON f.type_id = ft.type_id
        LEFT JOIN category c ON f.category_id = c.category_id
        LEFT JOIN Color col ON f.color_id = col.color_id
        WHERE f.deleted_at IS NULL
        ORDER BY f.fabric_id DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// 2. GET FABRIC BY ID
///////////////////////////////////////////////////////
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
        SELECT * FROM fabrics 
        WHERE fabric_id = ? AND deleted_at IS NULL
        `, [req.params.id]);

        if (!rows.length) {
            return res.status(404).json({ message: 'Fabric not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// สร้าง/แก้ไขผ้าไม่ทำที่นี่แล้ว — ผ้าต้องผูกกับผู้จัดจำหน่ายและมีรหัสผ้าเสมอ
//   สร้าง: POST /fabricrolls/receive (เพิ่มม้วนผ้า) หรือ POST /purchase_orders/:id/receive (ตรวจรับ)
//   แก้ไข: PUT /fabricrolls/:id (ชื่อ / หน้ากว้าง / รูป)

///////////////////////////////////////////////////////
//// 5. DELETE (SOFT DELETE)
///////////////////////////////////////////////////////
router.delete('/:id', async (req, res) => {
    try {
        const [result] = await pool.query(`
        UPDATE fabrics
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE fabric_id = ?
        `, [req.params.id]);

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'Fabric not found' });
        }

        res.json({ message: 'Fabric deleted successfully (Soft delete)' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;