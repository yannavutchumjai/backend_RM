const express = require('express');
const router = express.Router();
const { pool } = require('../db');


/* =================================
GET ALL USAGE
================================ */

router.get('/', async (req, res) => {

    try {

        const [rows] = await pool.query(`
        SELECT 
            ful.*,
            fr.roll_code
        FROM fabric_usage_logs ful
        LEFT JOIN fabric_rolls fr
        ON ful.roll_id = fr.roll_id
        WHERE ful.deleted_at IS NULL
        ORDER BY ful.usage_id DESC
        `);

        res.json(rows);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            message: "Server error"
        });

    }

});


/* =================================
GET USAGE DETAIL
================================ */

router.get('/:id', async (req, res) => {

    try {

        const [rows] = await pool.query(`
        SELECT *
        FROM fabric_usage_logs
        WHERE usage_id = ?
        AND deleted_at IS NULL
        `,[req.params.id]);

        if (!rows.length) {
            return res.status(404).json({
                message: "Usage not found"
            });
        }

        res.json(rows[0]);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            message: "Server error"
        });

    }

});


/* ================================
GET USAGE BY ROLL ID
================================ */

router.get("/roll/:roll_id", async (req, res) => {

  try {

    const { roll_id } = req.params;

    const [rows] = await pool.query(

      `SELECT 
        usage_id,
        roll_id,
        used_length,
        note,
        created_at
      FROM fabric_usage_logs
      WHERE roll_id = ?
      ORDER BY created_at DESC`,
      
      [roll_id]

    );

    res.json(rows);

  } catch (err) {

    console.error(err);
    res.status(500).json(err);

  }

});


/* =================================
GET USAGE HISTORY BY ROLL (ทุกแหล่ง)
  - manual    : บันทึกการใช้ผ้า (ตัดสต็อก)
  - calc      : คำนวณต้นทุนชุด แบบบันทึก+ตัดผ้า (ตัดสต็อก) — รวมเป็น 1 แถวต่อการคำนวณ
  - tailoring : ใบสั่งตัดที่เลือกม้วนนี้ (ไม่ตัดสต็อก — แสดงเพื่อให้รู้ว่าผ้าถูกเบิกไปที่ไหน)
================================ */
router.get("/roll/:roll_id/history", async (req, res) => {
  const rollId = Number(req.params.roll_id);

  try {
    const [manual] = await pool.query(
      `SELECT usage_id, used_length, note, created_at
         FROM fabric_usage_logs
        WHERE roll_id = ? AND deleted_at IS NULL`,
      [rollId]
    );

    const [calc] = await pool.query(
      `SELECT
          l.calc_id,
          MIN(l.created_at)  AS created_at,
          SUM(l.used_length) AS used_length,
          GROUP_CONCAT(
            CONCAT(TRIM(SUBSTRING_INDEX(l.used_for, '·', -1)), ' ', l.used_length)
            ORDER BY l.usage_id SEPARATOR ' · '
          ) AS parts,
          s.product_type,
          s.qty,
          p.lot_code   AS product_lot,
          p.name       AS product_name,
          p.deleted_at AS product_deleted_at
        FROM fabric_calc_usage_logs l
        LEFT JOIN fabric_calc_sessions s ON s.calc_id = l.calc_id
        LEFT JOIN products p             ON p.id = s.product_id
       WHERE l.roll_id = ?
       GROUP BY l.calc_id, s.product_type, s.qty, p.lot_code, p.name, p.deleted_at`,
      [rollId]
    );

    const [tailoring] = await pool.query(
      `SELECT
          sf.item_id,
          sf.meters_issued,
          i.piece_no,
          i.status,
          o.order_code,
          o.customer_name,
          COALESCE(o.order_date, o.created_at) AS created_at
        FROM tailoring_order_shop_fabric sf
        JOIN tailoring_order_items i ON i.item_id  = sf.item_id
        JOIN tailoring_orders o      ON o.order_id = i.order_id
       WHERE sf.roll_id = ? AND i.deleted_at IS NULL AND o.deleted_at IS NULL`,
      [rollId]
    );

    const history = [
      ...manual.map((r) => ({
        source: "manual",
        key: `manual-${r.usage_id}`,
        created_at: r.created_at,
        used_length: Number(r.used_length),
        deducted: true,
        title: "บันทึกการใช้ผ้า",
        detail: r.note || "",
      })),
      ...calc.map((r) => ({
        source: "calc",
        key: `calc-${r.calc_id}`,
        created_at: r.created_at,
        used_length: Math.round(Number(r.used_length) * 100) / 100,
        deducted: true,
        title: `คำนวณต้นทุนชุด #${r.calc_id}${r.product_type ? ` · ${r.product_type}` : ""}${Number(r.qty) > 1 ? ` × ${r.qty}` : ""}`,
        detail: r.parts || "",
        product_lot: r.product_lot || null,
        product_name: r.product_name || null,
        product_deleted: !!r.product_deleted_at,
      })),
      ...tailoring.map((r) => ({
        source: "tailoring",
        key: `tailoring-${r.item_id}`,
        created_at: r.created_at,
        used_length: r.meters_issued == null ? null : Number(r.meters_issued),
        deducted: false,
        title: `ใบสั่งตัด ${r.order_code}${r.customer_name ? ` · ${r.customer_name}` : ""}`,
        detail: `ชิ้นที่ ${r.piece_no || "-"}${r.status ? ` · ${r.status}` : ""}`,
        order_code: r.order_code,
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(history);
  } catch (err) {
    console.error("Error fetching roll usage history:", err);
    res.status(500).json({ message: "Server error" });
  }
});


/* =================================
CREATE USAGE (CUT FABRIC)
================================ */

router.post('/', async (req, res) => {

    const conn = await pool.getConnection();

    try {

        const { roll_id, used_length, note } = req.body;

        await conn.beginTransaction();

        const [roll] = await conn.query(`
        SELECT remaining_length, cost_per_meter
        FROM fabric_rolls
        WHERE roll_id = ?
        `,[roll_id]);

        if (!roll.length) {
            await conn.rollback();
            return res.status(404).json({
                message: "Fabric roll not found"
            });
        }

        const remaining = roll[0].remaining_length;
        const cost = roll[0].cost_per_meter;

        if (used_length > remaining) {
            await conn.rollback();
            return res.status(400).json({
                message: "Not enough fabric"
            });
        }

        const remaining_after = remaining - used_length;
        const total_cost = used_length * cost;

        await conn.query(`
        INSERT INTO fabric_usage_logs
        (
            roll_id,
            used_length,
            cost_per_meter,
            total_cost,
            remaining_after,
            note
        )
        VALUES (?,?,?,?,?,?)
        `,[
            roll_id,
            used_length,
            cost,
            total_cost,
            remaining_after,
            note
        ]);

        await conn.query(`
        UPDATE fabric_rolls
        SET remaining_length = ?
        WHERE roll_id = ?
        `,[remaining_after, roll_id]);

        await conn.commit();

        res.status(201).json({
            message: "Fabric used successfully",
            remaining_after
        });

    } catch (err) {

        await conn.rollback();
        console.error(err);
        res.status(500).json({
            message: "Server error"
        });

    } finally {

        conn.release();

    }

});


/* =================================
SOFT DELETE
================================ */

router.delete('/:id', async (req, res) => {

    try {

        const [result] = await pool.query(`
        UPDATE fabric_usage_logs
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE usage_id = ?
        `,[req.params.id]);

        if (!result.affectedRows) {
            return res.status(404).json({
                message: "Not found"
            });
        }

        res.json({
            message: "Deleted"
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            message: "Server error"
        });

    }

});


module.exports = router;