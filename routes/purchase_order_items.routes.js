const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { findFabricBySpec, fabricNameOf, toWidth } = require('../lib/fabricCodes');

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildItemPayload(body = {}) {
  const rollQty = toNumber(body.roll_qty, 0);
  const pricePerRoll = toNumber(body.price_per_roll, 0);
  const rollLength = toNumber(body.roll_length, 0);

  return {
    po_id: body.po_id ? Number(body.po_id) : null,
    fabric_id: body.fabric_id ? Number(body.fabric_id) : null,
    type_id: body.type_id ? Number(body.type_id) : null,
    category_id: body.category_id ? Number(body.category_id) : null,
    color_id: body.color_id ? Number(body.color_id) : null,
    fabric_name: (body.fabric_name || '').trim() || null,
    width_cm: toWidth(body.width_cm),
    roll_qty: rollQty,
    price_per_roll: pricePerRoll,
    roll_length: rollLength,
    total_price: Number((rollQty * pricePerRoll).toFixed(2)),
  };
}

function validateItem(item) {
  if (!item.po_id) return 'po_id is required';
  if (!item.fabric_id && !(item.type_id && item.category_id && item.color_id)) {
    return 'ต้องเลือกผ้า หรือระบุประเภทผ้า ลวดลาย และสี';
  }
  if (item.roll_qty <= 0) return 'roll_qty must be greater than 0';
  if (item.price_per_roll < 0) return 'price_per_roll must be 0 or greater';
  if (item.roll_length <= 0) return 'roll_length must be greater than 0';
  return null;
}

// ผ้าที่สั่ง: เลือกผ้าที่มีแล้ว → ใช้สเปกของผ้านั้น
// ระบุสเปกใหม่ → ถ้าร้านนี้มีผ้าสเปกนี้อยู่แล้วผูก fabric_id ให้ ถ้าไม่มีเว้นว่างไว้ (สร้างตอนตรวจรับ)
async function resolveFabricSpec(conn, item) {
  if (item.fabric_id) {
    const [rows] = await conn.query(
      'SELECT type_id, category_id, color_id, fabric_name FROM fabrics WHERE fabric_id = ?',
      [item.fabric_id]
    );
    if (!rows.length) throw Object.assign(new Error('ไม่พบผ้าที่เลือก'), { status: 400 });
    return { ...item, ...rows[0] };
  }

  const [po] = await conn.query('SELECT supplier_id FROM purchase_orders WHERE po_id = ?', [item.po_id]);
  if (!po.length) throw Object.assign(new Error('ไม่พบใบสั่งซื้อ'), { status: 404 });

  const spec = {
    supplier_id: po[0].supplier_id,
    type_id: item.type_id,
    category_id: item.category_id,
    color_id: item.color_id,
  };
  const fabric = await findFabricBySpec(conn, spec);
  const live = fabric && !fabric.deleted_at ? fabric : null;

  return {
    ...item,
    fabric_id: live ? live.fabric_id : null,
    fabric_name: live?.fabric_name || item.fabric_name || await fabricNameOf(conn, spec),
  };
}

const ITEM_SELECT = `
  SELECT
    poi.item_id,
    poi.po_id,
    po.po_code,
    poi.fabric_id,
    f.fabric_code,
    COALESCE(f.fabric_name, poi.fabric_name) AS fabric_name,
    COALESCE(f.width_cm, poi.width_cm) AS width_cm,
    poi.type_id,
    ft.type_name,
    poi.category_id,
    c.category_name,
    poi.color_id,
    col.color_name,
    poi.roll_qty,
    poi.price_per_roll,
    poi.roll_length,
    poi.total_price,
    poi.received_roll_qty
  FROM purchase_order_items poi
  LEFT JOIN purchase_orders po ON poi.po_id = po.po_id
  LEFT JOIN fabrics f ON poi.fabric_id = f.fabric_id
  LEFT JOIN fabric_types ft ON poi.type_id = ft.type_id
  LEFT JOIN category c ON poi.category_id = c.category_id
  LEFT JOIN Color col ON poi.color_id = col.color_id
`;

router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(`${ITEM_SELECT} ORDER BY poi.item_id DESC`);
    res.json(rows);
  } catch (e) {
    console.error('GET /purchase_order_items error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/po/:po_id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `${ITEM_SELECT} WHERE poi.po_id = ? ORDER BY poi.item_id ASC`,
      [req.params.po_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /purchase_order_items/po/:po_id error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`${ITEM_SELECT} WHERE poi.item_id = ?`, [req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ message: 'Purchase order item not found' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('GET /purchase_order_items/:id error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = buildItemPayload(req.body || {});
    const errorMessage = validateItem(payload);

    if (errorMessage) {
      return res.status(400).json({ message: errorMessage });
    }

    const item = await resolveFabricSpec(pool, payload);

    // ผ้าใหม่ (ยังไม่มีใน fabrics) ต้องระบุหน้ากว้าง เพื่อใช้ตอนตรวจรับ
    if (!item.fabric_id && item.width_cm == null) {
      return res.status(400).json({ message: 'กรุณากรอกหน้ากว้างของผ้าใหม่' });
    }

    // จำนวนที่รับแล้วเริ่มที่ 0 เสมอ — เพิ่มได้จากการตรวจรับเท่านั้น
    const [result] = await pool.query(
      `INSERT INTO purchase_order_items
       (po_id, fabric_id, type_id, category_id, color_id, fabric_name, width_cm,
        roll_qty, price_per_roll, roll_length, total_price, received_roll_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        item.po_id,
        item.fabric_id,
        item.type_id,
        item.category_id,
        item.color_id,
        item.fabric_name,
        item.width_cm,
        item.roll_qty,
        item.price_per_roll,
        item.roll_length,
        item.total_price,
      ]
    );

    res.status(201).json({
      message: 'Purchase order item created',
      item_id: result.insertId,
      fabric_id: item.fabric_id,
      fabric_name: item.fabric_name,
      total_price: item.total_price,
    });
  } catch (e) {
    console.error('POST /purchase_order_items error:', e);
    res.status(e.status || 500).json({ message: e.message || 'Server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const [existingRows] = await pool.query(
      `SELECT po_id, fabric_id, type_id, category_id, color_id, fabric_name, width_cm,
              roll_qty, price_per_roll, roll_length, received_roll_qty
       FROM purchase_order_items
       WHERE item_id = ?`,
      [req.params.id]
    );

    if (!existingRows.length) {
      return res.status(404).json({ message: 'Purchase order item not found' });
    }

    const current = existingRows[0];
    const body = req.body || {};

    // ส่งผ้ามาใหม่ (fabric_id หรือสเปก) → ใช้ของใหม่ ไม่ส่งมา → ใช้ของเดิม
    const fabricChanged = body.fabric_id !== undefined || body.type_id !== undefined;
    const fabricFields = fabricChanged ? body : current;
    const payload = buildItemPayload({
      po_id: body.po_id ?? current.po_id,
      fabric_id: fabricFields.fabric_id,
      type_id: fabricFields.type_id,
      category_id: fabricFields.category_id,
      color_id: fabricFields.color_id,
      fabric_name: fabricFields.fabric_name,
      width_cm: fabricFields.width_cm,
      roll_qty: body.roll_qty ?? current.roll_qty,
      price_per_roll: body.price_per_roll ?? current.price_per_roll,
      roll_length: body.roll_length ?? current.roll_length,
    });
    const errorMessage = validateItem(payload);

    if (errorMessage) {
      return res.status(400).json({ message: errorMessage });
    }

    const item = fabricChanged ? await resolveFabricSpec(pool, payload) : payload;
    const received = Number(current.received_roll_qty || 0);

    if (received > 0) {
      const sameFabric =
        Number(item.type_id) === Number(current.type_id) &&
        Number(item.category_id) === Number(current.category_id) &&
        Number(item.color_id) === Number(current.color_id);
      if (!sameFabric) {
        return res.status(400).json({ message: 'รายการนี้รับของแล้ว เปลี่ยนผ้าไม่ได้' });
      }
      // ผ้าถูกสร้างไปแล้วตอนตรวจรับ ให้คงผ้าเดิมไว้
      item.fabric_id = current.fabric_id;
    }
    if (item.roll_qty < received) {
      return res.status(400).json({ message: `รับของไปแล้ว ${received} ม้วน จำนวนสั่งต้องไม่น้อยกว่านี้` });
    }

    // received_roll_qty ไม่ให้แก้ตรงนี้ — เปลี่ยนได้จากการตรวจรับเท่านั้น
    const [result] = await pool.query(
      `UPDATE purchase_order_items
       SET po_id = ?,
           fabric_id = ?,
           type_id = ?,
           category_id = ?,
           color_id = ?,
           fabric_name = ?,
           width_cm = ?,
           roll_qty = ?,
           price_per_roll = ?,
           roll_length = ?,
           total_price = ?
       WHERE item_id = ?`,
      [
        item.po_id,
        item.fabric_id,
        item.type_id,
        item.category_id,
        item.color_id,
        item.fabric_name,
        item.width_cm,
        item.roll_qty,
        item.price_per_roll,
        item.roll_length,
        item.total_price,
        req.params.id,
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Purchase order item not found' });
    }

    res.json({
      message: 'Purchase order item updated',
      total_price: item.total_price,
    });
  } catch (e) {
    console.error('PUT /purchase_order_items/:id error:', e);
    res.status(e.status || 500).json({ message: e.message || 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT received_roll_qty FROM purchase_order_items WHERE item_id = ?',
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Purchase order item not found' });
    }
    if (Number(rows[0].received_roll_qty) > 0) {
      return res.status(400).json({ message: 'รายการนี้รับของแล้ว ลบไม่ได้' });
    }

    await pool.query('DELETE FROM purchase_order_items WHERE item_id = ?', [req.params.id]);
    res.json({ message: 'Purchase order item deleted' });
  } catch (e) {
    console.error('DELETE /purchase_order_items/:id error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
