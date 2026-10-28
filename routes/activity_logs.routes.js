const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { logActivity } = require('../lib/activityLog');

/* การบันทึกทำฝั่ง server เท่านั้น (ผ่าน middleware activityLogger ใน app.js)
   route นี้จึงมีแค่ "อ่าน" — ไม่เปิดให้แก้/ลบ log เพื่อให้ตรวจย้อนหลังได้จริง */

/* =========================
   GET /activity_logs
   query: q, module, status, from (YYYY-MM-DD), to (YYYY-MM-DD), page, limit
   คืน: { rows, total, page, limit, summary: { total, success, warning, error } }
========================= */
router.get('/', async (req, res) => {
    try {
        const { q, module, status, from, to } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));

        const where = [];
        const params = [];

        /* module ส่งมาได้หลายค่าคั่นด้วย comma เช่น "users,login" (ข้อมูลเก่าใช้ชื่อต่างกัน) */
        const modules = String(module || '').split(',').map((m) => m.trim()).filter((m) => m && m !== 'all');
        if (modules.length) {
            where.push(`l.module IN (${modules.map(() => '?').join(',')})`);
            params.push(...modules);
        }
        /* เก็บเฉพาะการกระทำหลัก ไม่แสดงการเปิดดูหน้า (ข้อมูลเก่าที่เคยบันทึกไว้) */
        where.push("(l.log_type IS NULL OR l.log_type <> 'VIEW')");
        if (from) {
            where.push('l.created_at >= ?');
            params.push(`${from} 00:00:00`);
        }
        if (to) {
            where.push('l.created_at <= ?');
            params.push(`${to} 23:59:59`);
        }
        if (q && q.trim()) {
            const like = `%${q.trim()}%`;
            where.push('(u.name LIKE ? OR u.email LIKE ? OR l.action LIKE ? OR l.detail LIKE ? OR l.id = ?)');
            params.push(like, like, like, like, q.trim());
        }

        /* ตัวเลขสรุปใช้เงื่อนไขเดียวกันยกเว้น status (การ์ดจะได้แสดงสัดส่วนครบทุกสถานะ) */
        const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const [[summary]] = await pool.query(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(l.status = 'success'), 0) AS success,
                    COALESCE(SUM(l.status = 'warning'), 0) AS warning,
                    COALESCE(SUM(l.status = 'error'), 0)   AS error
             FROM activity_logs l
             LEFT JOIN users u ON u.id = l.user_id
             ${baseWhere}`,
            params
        );

        const listWhere = [...where];
        const listParams = [...params];
        if (status && status !== 'all') {
            listWhere.push('l.status = ?');
            listParams.push(status);
        }
        const listWhereSql = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM activity_logs l
             LEFT JOIN users u ON u.id = l.user_id
             ${listWhereSql}`,
            listParams
        );

        const [rows] = await pool.query(
            `SELECT l.id, l.user_id, l.module, l.action, l.detail, l.status, l.log_type,
                    DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
                    u.name AS user_name, u.role AS user_role
             FROM activity_logs l
             LEFT JOIN users u ON u.id = l.user_id
             ${listWhereSql}
             ORDER BY l.created_at DESC, l.id DESC
             LIMIT ? OFFSET ?`,
            [...listParams, limit, (page - 1) * limit]
        );

        res.json({
            rows,
            total: Number(total),
            page,
            limit,
            summary: {
                total: Number(summary.total),
                success: Number(summary.success),
                warning: Number(summary.warning),
                error: Number(summary.error),
            },
        });
    } catch (e) {
        console.error('GET /activity_logs error:', e);
        res.status(500).json({ message: 'Server error' });
    }
});

/* =========================
   POST /activity_logs/logout
   การออกจากระบบทำฝั่งหน้าเว็บอย่างเดียว (ลบ localStorage) server จึงไม่รู้
   หน้าเว็บเลยต้องแจ้งมาที่นี่ก่อนลบข้อมูลผู้ใช้
========================= */
router.post('/logout', async (req, res) => {
    const n = Number(req.headers['x-user-id']);
    const userId = Number.isInteger(n) && n > 0 ? n : null;
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    await logActivity({ userId, module: 'users', action: 'logout', detail: `ออกจากระบบ จาก IP ${ip}` });
    res.json({ message: 'ok' });
});

/* =========================
   POST /activity_logs/action   body: { module, action, detail }
   การกระทำที่เกิดฝั่งหน้าเว็บอย่างเดียว server มองไม่เห็น เช่น สั่งพิมพ์ใบเสร็จ
========================= */
const MODULES = ['users', 'products', 'sales', 'stock', 'promotion', 'settings', 'reports', 'other'];

router.post('/action', async (req, res) => {
    const n = Number(req.headers['x-user-id']);
    const userId = Number.isInteger(n) && n > 0 ? n : null;
    const { module, action, detail } = req.body || {};
    if (!userId || typeof action !== 'string' || !/^[a-z_]{1,50}$/.test(action)) {
        return res.status(400).json({ message: 'user & action are required' });
    }
    await logActivity({
        userId,
        module: MODULES.includes(module) ? module : 'other',
        action,
        detail: typeof detail === 'string' ? detail.slice(0, 500) : null,
    });
    res.json({ message: 'ok' });
});

module.exports = router;
