const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const {
  findFabricBySpec,
  nextFabricCode,
  nextLotNo,
  ensureFabric,
  insertRoll,
} = require('../lib/fabricCodes');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const ALLOWED_STATUSES = ['pending', 'partial', 'completed'];

function normalizeStatus(status) {
  return typeof status === 'string' ? status.trim().toLowerCase() : null;
}

router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        po.po_id,
        po.po_code,
        po.supplier_id,
        s.supplier_name,
        po.order_date,
        po.status,
        po.total_amount
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.supplier_id
      ORDER BY po.po_id DESC
    `);

    res.json(rows);
  } catch (e) {
    console.error('GET /purchase_orders error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         po.po_id,
         po.po_code,
         po.supplier_id,
         s.supplier_name,
         po.order_date,
         po.status,
         po.total_amount
       FROM purchase_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.supplier_id
       WHERE po.po_id = ?`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('GET /purchase_orders/:id error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { po_code, supplier_id, order_date, status, total_amount } = req.body || {};
    const normalizedStatus = normalizeStatus(status);

    if (!po_code || !supplier_id || !order_date || total_amount === undefined) {
      return res.status(400).json({
        message: 'po_code, supplier_id, order_date, total_amount are required',
      });
    }

    if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        message: 'status must be pending, partial, or completed',
      });
    }

    const [result] = await pool.query(
      `INSERT INTO purchase_orders
       (po_code, supplier_id, order_date, status, total_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [
        po_code,
        supplier_id,
        order_date,
        normalizedStatus,
        Number(total_amount),
      ]
    );

    res.status(201).json({
      message: 'Purchase order created',
      po_id: result.insertId,
    });
  } catch (e) {
    console.error('POST /purchase_orders error:', e);
    res.status(500).json({ message: e.message || 'Server error' });
  }
});

///////////////////////////////////////////////////////
//// ตรวจรับสินค้า → สร้างผ้า (ถ้ายังไม่มี) + ม้วนผ้าเข้าคลัง + ราคาต่อเมตร
//// body: { storage_location, receive_date?, items: [{ item_id, receive_qty, lengths: [เมตรของแต่ละม้วน] }] }
//// การรับ 1 ครั้งของผ้า 1 รายการ = 1 ล็อต
///////////////////////////////////////////////////////
router.post('/:id/receive', async (req, res) => {
  const inputs = Array.isArray(req.body?.items) ? req.body.items : [];
  const storageLocation = String(req.body?.storage_location || '').trim() || null;
  const receiveDate = req.body?.receive_date || null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poRows] = await conn.query(
      'SELECT po_id, supplier_id FROM purchase_orders WHERE po_id = ? FOR UPDATE',
      [req.params.id]
    );
    if (!poRows.length) throw httpError(404, 'ไม่พบใบสั่งซื้อ');

    const supplierId = poRows[0].supplier_id;
    if (!supplierId) throw httpError(400, 'ใบสั่งซื้อนี้ไม่มีผู้จัดจำหน่าย');

    // ล็อกแถวผู้จัดจำหน่าย ให้การออกรหัสของร้านเดียวกันทำทีละรายการ
    await conn.query('SELECT supplier_id FROM suppliers WHERE supplier_id = ? FOR UPDATE', [supplierId]);

    const createdRolls = [];

    for (const input of inputs) {
      const qty = Math.floor(Number(input.receive_qty) || 0);
      if (qty <= 0) continue;

      const [itemRows] = await conn.query(
        'SELECT * FROM purchase_order_items WHERE item_id = ? AND po_id = ? FOR UPDATE',
        [input.item_id, req.params.id]
      );
      if (!itemRows.length) throw httpError(400, 'ไม่พบรายการในใบสั่งซื้อ');

      const item = itemRows[0];
      const remaining = Number(item.roll_qty) - Number(item.received_roll_qty || 0);
      if (qty > remaining) {
        throw httpError(400, `${item.fabric_name || 'รายการผ้า'} รับได้อีกไม่เกิน ${remaining} ม้วน`);
      }

      const spec = {
        supplier_id: supplierId,
        type_id: item.type_id,
        category_id: item.category_id,
        color_id: item.color_id,
      };
      if (!spec.type_id || !spec.category_id || !spec.color_id) {
        throw httpError(400, `${item.fabric_name || 'รายการผ้า'} ไม่มีข้อมูลประเภทผ้า ลวดลาย สี`);
      }

      // ผ้าเก่าที่ยังไม่มีเจ้าของ → ยกให้ร้านของใบสั่งซื้อนี้ (ถ้าร้านนี้ยังไม่มีผ้าสเปกเดียวกัน)
      if (item.fabric_id) {
        const [[legacy]] = await conn.query(
          'SELECT supplier_id FROM fabrics WHERE fabric_id = ? FOR UPDATE',
          [item.fabric_id]
        );
        if (legacy && legacy.supplier_id == null && !(await findFabricBySpec(conn, spec))) {
          await conn.query(
            'UPDATE fabrics SET supplier_id = ?, fabric_code = ? WHERE fabric_id = ?',
            [supplierId, await nextFabricCode(conn, supplierId), item.fabric_id]
          );
        }
      }

      const fabric = await ensureFabric(conn, spec, {
        fabricName: item.fabric_name,
        widthCm: item.width_cm,
      });
      const lotNo = await nextLotNo(conn, fabric.fabric_id);
      const lengths = Array.isArray(input.lengths) ? input.lengths : [];

      for (let rollNo = 1; rollNo <= qty; rollNo += 1) {
        const typed = Number(lengths[rollNo - 1]);
        const length = typed > 0 ? typed : Number(item.roll_length);
        if (!(length > 0)) throw httpError(400, 'ความยาวม้วนต้องมากกว่า 0');

        const roll = await insertRoll(conn, {
          fabric,
          spec,
          lotNo,
          rollNo,
          length,
          totalPrice: Number(item.price_per_roll),
          purchaseDate: receiveDate,
          storageLocation,
          poItemId: item.item_id,
        });
        createdRolls.push({ ...roll, fabric_name: fabric.fabric_name, length });
      }

      await conn.query(
        `UPDATE purchase_order_items
         SET received_roll_qty = received_roll_qty + ?,
             fabric_id = ?
         WHERE item_id = ?`,
        [qty, fabric.fabric_id, item.item_id]
      );
    }

    if (!createdRolls.length) throw httpError(400, 'กรุณาระบุจำนวนม้วนที่รับครั้งนี้');

    const [[sum]] = await conn.query(
      `SELECT SUM(roll_qty) AS ordered, SUM(received_roll_qty) AS received
       FROM purchase_order_items WHERE po_id = ?`,
      [req.params.id]
    );
    const status =
      Number(sum.received) >= Number(sum.ordered)
        ? 'completed'
        : Number(sum.received) > 0
          ? 'partial'
          : 'pending';
    await conn.query('UPDATE purchase_orders SET status = ? WHERE po_id = ?', [status, req.params.id]);

    await conn.commit();
    res.status(201).json({ message: 'Received', status, rolls: createdRolls });
  } catch (e) {
    await conn.rollback();
    console.error('POST /purchase_orders/:id/receive error:', e);
    res.status(e.status || 500).json({ message: e.status ? e.message : 'Server error' });
  } finally {
    conn.release();
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { po_code, supplier_id, order_date, status, total_amount } = req.body || {};
    const normalizedStatus = status === undefined ? null : normalizeStatus(status);

    // รับของแล้ว → เปลี่ยนผู้จัดจำหน่ายไม่ได้ (ม้วนผ้าผูกกับร้านเดิมไปแล้ว)
    if (supplier_id) {
      const [[current]] = await pool.query(
        `SELECT po.supplier_id, COALESCE(SUM(poi.received_roll_qty), 0) AS received
         FROM purchase_orders po
         LEFT JOIN purchase_order_items poi ON poi.po_id = po.po_id
         WHERE po.po_id = ?
         GROUP BY po.po_id`,
        [req.params.id]
      );
      if (current && Number(current.received) > 0 && Number(current.supplier_id) !== Number(supplier_id)) {
        return res.status(400).json({ message: 'ใบสั่งซื้อนี้รับของแล้ว เปลี่ยนผู้จัดจำหน่ายไม่ได้' });
      }
    }

    if (normalizedStatus !== null && !ALLOWED_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        message: 'status must be pending, partial, or completed',
      });
    }

    const [result] = await pool.query(
      `UPDATE purchase_orders
       SET po_code = COALESCE(?, po_code),
           supplier_id = COALESCE(?, supplier_id),
           order_date = COALESCE(?, order_date),
           status = COALESCE(?, status),
           total_amount = COALESCE(?, total_amount)
       WHERE po_id = ?`,
      [
        po_code || null,
        supplier_id || null,
        order_date || null,
        normalizedStatus,
        total_amount !== undefined ? Number(total_amount) : null,
        req.params.id,
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }

    res.json({ message: 'Purchase order updated' });
  } catch (e) {
    console.error('PUT /purchase_orders/:id error:', e);
    res.status(500).json({ message: e.message || 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[linked]] = await conn.query(
      `SELECT COUNT(*) AS n
       FROM fabric_rolls fr
       JOIN purchase_order_items poi ON poi.item_id = fr.po_item_id
       WHERE poi.po_id = ?`,
      [req.params.id]
    );
    if (Number(linked.n) > 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'ใบสั่งซื้อนี้มีม้วนผ้าที่รับเข้าคลังแล้ว ลบไม่ได้' });
    }

    await conn.query(
      'DELETE FROM purchase_order_items WHERE po_id = ?',
      [req.params.id]
    );

    const [result] = await conn.query(
      'DELETE FROM purchase_orders WHERE po_id = ?',
      [req.params.id]
    );

    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ message: 'Purchase order not found' });
    }

    await conn.commit();
    res.json({ message: 'Purchase order deleted' });
  } catch (e) {
    await conn.rollback();
    console.error('DELETE /purchase_orders/:id error:', e);
    res.status(500).json({ message: e.message || 'Server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;
