const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { normalizePhone } = require('../lib/phone');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

const groupBy = (rows, key) => {
    const map = {};
    rows.forEach((row) => {
        if (!map[row[key]]) map[row[key]] = [];
        map[row[key]].push(row);
    });
    return map;
};

///////////////////////////////////////////////////////
//// GET ALL TAILORING ORDERS (list page — items summary only)
///////////////////////////////////////////////////////
router.get('/', async (req, res) => {
    try {
        const { bill_id } = req.query;
        const where = bill_id
            ? 'WHERE t.deleted_at IS NULL AND t.bill_id = ?'
            : 'WHERE t.deleted_at IS NULL';
        const params = bill_id ? [bill_id] : [];

        const [orders] = await pool.query(`
            SELECT t.order_id, t.order_code, t.order_number, t.customer_name, t.customer_phone,
                   DATE_FORMAT(t.order_date, '%Y-%m-%d') AS order_date,
                   DATE_FORMAT(t.deadline, '%Y-%m-%d') AS deadline,
                   DATE_FORMAT(t.fitting_date, '%Y-%m-%d') AS fitting_date,
                   t.deposit, t.deposit_payment_method,
                   t.final_paid_amount, t.final_payment_method, t.final_payment_slip,
                   DATE_FORMAT(t.final_paid_at, '%Y-%m-%d') AS final_paid_at,
                   t.created_by, t.bill_id, t.created_at,
                   b.Bill_details AS bill_no,
                   (SELECT COALESCE(SUM(i.price), 0)
                      FROM tailoring_order_items i
                     WHERE i.order_id = t.order_id AND i.deleted_at IS NULL) AS pieces_total,
                   (SELECT COALESCE(SUM(al.fee_amount), 0)
                      FROM tailoring_order_alterations al
                      JOIN tailoring_order_items i2 ON i2.item_id = al.item_id
                     WHERE i2.order_id = t.order_id AND i2.deleted_at IS NULL) AS alterations_total,
                   (SELECT DATE_FORMAT(MIN(a.appointment_date), '%Y-%m-%d')
                      FROM tailoring_order_appointments a
                     WHERE a.order_id = t.order_id AND a.purpose LIKE '%รับ%') AS pickup_date,
                   (SELECT DATE_FORMAT(a.appointment_date, '%Y-%m-%d')
                      FROM tailoring_order_appointments a
                     WHERE a.order_id = t.order_id AND a.done = 0
                       AND a.appointment_date >= CURDATE()
                     ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 1) AS next_appointment_date,
                   (SELECT a.purpose
                      FROM tailoring_order_appointments a
                     WHERE a.order_id = t.order_id AND a.done = 0
                       AND a.appointment_date >= CURDATE()
                     ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 1) AS next_appointment_purpose,
                   (SELECT TIME_FORMAT(a.appointment_time, '%H:%i')
                      FROM tailoring_order_appointments a
                     WHERE a.order_id = t.order_id AND a.done = 0
                       AND a.appointment_date >= CURDATE()
                     ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 1) AS next_appointment_time
            FROM tailoring_orders t
            LEFT JOIN Bill b ON b.idBill = t.bill_id
            ${where}
            ORDER BY t.order_id DESC
        `, params);

        if (!orders.length) return res.json([]);

        const [items] = await pool.query(`
            SELECT item_id, order_id, piece_no, garment_type, subtype, status, price
            FROM tailoring_order_items
            WHERE deleted_at IS NULL
            ORDER BY order_id, piece_no
        `);

        /* วันนัดทั้งหมด — หน้าปฏิทินต้องใช้ทุกนัด ไม่ใช่แค่นัดถัดไป
           และตอนแก้/ลบนัดต้องส่งรายการทั้งใบกลับมา (PUT เขียนทับทั้งชุด) */
        const [appointments] = await pool.query(`
            SELECT appointment_id, order_id,
                   DATE_FORMAT(appointment_date, '%Y-%m-%d') AS appointment_date,
                   TIME_FORMAT(appointment_time, '%H:%i') AS appointment_time,
                   purpose, note, done
            FROM tailoring_order_appointments
            ORDER BY order_id, appointment_date ASC, appointment_time ASC, appointment_id ASC
        `);

        const itemsByOrder = groupBy(items, 'order_id');
        const apptsByOrder = groupBy(appointments, 'order_id');
        res.json(orders.map((o) => ({
            ...o,
            items: itemsByOrder[o.order_id] || [],
            appointments: apptsByOrder[o.order_id] || [],
        })));
    } catch (err) {
        console.error('Error fetching tailoring orders:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// GET SINGLE TAILORING ORDER BY order_code (full detail)
//// ต้องอยู่ก่อน /:id เพราะ "code" ไม่ใช่ตัวเลข
///////////////////////////////////////////////////////
router.get('/code/:code', async (req, res) => {
    try {
        const [orders] = await pool.query(
            `SELECT order_id, order_code, order_number, customer_name, customer_phone,
                    DATE_FORMAT(order_date, '%Y-%m-%d') AS order_date,
                    DATE_FORMAT(deadline, '%Y-%m-%d') AS deadline,
                    DATE_FORMAT(fitting_date, '%Y-%m-%d') AS fitting_date,
                    deposit, deposit_payment_method,
                    final_paid_amount, final_payment_method, final_payment_slip,
                    DATE_FORMAT(final_paid_at, '%Y-%m-%d') AS final_paid_at,
                    created_by, bill_id, created_at, updated_at
             FROM tailoring_orders WHERE order_code = ? AND deleted_at IS NULL`,
            [req.params.code]
        );
        if (!orders.length) return res.status(404).json({ message: 'Not found' });

        const order = orders[0];

        const [items] = await pool.query(
            `SELECT * FROM tailoring_order_items WHERE order_id = ? AND deleted_at IS NULL ORDER BY piece_no`,
            [order.order_id]
        );

        const itemIds = items.map((it) => it.item_id);
        let shopFabric = [], customerFabric = [], measurements = [], seamAllowance = [], photos = [], alterations = [];

        if (itemIds.length) {
            [[shopFabric], [customerFabric], [measurements], [seamAllowance], [photos], [alterations]] = await Promise.all([
                pool.query(
                    `SELECT sf.*, fr.roll_code, fr.remaining_length
                     FROM tailoring_order_shop_fabric sf
                     LEFT JOIN fabric_rolls fr ON fr.roll_id = sf.roll_id
                     WHERE sf.item_id IN (?)`,
                    [itemIds]
                ),
                pool.query(
                    `SELECT item_id, DATE_FORMAT(received_date, '%Y-%m-%d') AS received_date,
                            roll_count, measured_length, measured_width, condition_note,
                            washed, acknowledged, enough, adjustment_note, return_scraps
                     FROM tailoring_order_customer_fabric WHERE item_id IN (?)`,
                    [itemIds]
                ),
                pool.query(`SELECT * FROM tailoring_order_measurements WHERE item_id IN (?) ORDER BY measurement_id`, [itemIds]),
                pool.query(`SELECT * FROM tailoring_order_seam_allowance WHERE item_id IN (?)`, [itemIds]),
                pool.query(`SELECT * FROM tailoring_order_photos WHERE item_id IN (?) ORDER BY photo_id`, [itemIds]),
                pool.query(
                    `SELECT alteration_id, item_id, DATE_FORMAT(alteration_date, '%Y-%m-%d') AS alteration_date,
                            point, adjust_cm, remaining_allowance, fee_amount, created_at
                     FROM tailoring_order_alterations WHERE item_id IN (?) ORDER BY alteration_id`,
                    [itemIds]
                ),
            ]);
        }

        const measurementsByItem = groupBy(measurements, 'item_id');
        const seamByItem = groupBy(seamAllowance, 'item_id');
        const photosByItem = groupBy(photos, 'item_id');
        const alterationsByItem = groupBy(alterations, 'item_id');
        const shopFabricByItem = {};
        shopFabric.forEach((r) => { shopFabricByItem[r.item_id] = r; });
        const customerFabricByItem = {};
        customerFabric.forEach((r) => { customerFabricByItem[r.item_id] = r; });

        const fullItems = items.map((it) => ({
            ...it,
            shop_fabric: shopFabricByItem[it.item_id] || null,
            customer_fabric: customerFabricByItem[it.item_id] || null,
            measurements: measurementsByItem[it.item_id] || [],
            seam_allowance: seamByItem[it.item_id] || [],
            photos: photosByItem[it.item_id] || [],
            alterations: alterationsByItem[it.item_id] || [],
        }));

        const [appointments] = await pool.query(
            `SELECT appointment_id, order_id,
                    DATE_FORMAT(appointment_date, '%Y-%m-%d') AS appointment_date,
                    TIME_FORMAT(appointment_time, '%H:%i') AS appointment_time,
                    purpose, note, done
             FROM tailoring_order_appointments
             WHERE order_id = ?
             ORDER BY appointment_date ASC, appointment_time ASC, appointment_id ASC`,
            [order.order_id]
        );

        const [[billRow]] = order.bill_id
            ? await pool.query('SELECT Bill_details FROM Bill WHERE idBill = ?', [order.bill_id])
            : [[null]];

        res.json({
            ...order,
            bill_no: billRow?.Bill_details || null,
            appointments,
            items: fullItems,
        });
    } catch (err) {
        console.error('Error fetching tailoring order detail:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// GET SINGLE TAILORING ORDER BY numeric order_id
///////////////////////////////////////////////////////
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM tailoring_orders WHERE order_id = ? AND deleted_at IS NULL`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ message: 'Not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching tailoring order:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// CREATE TAILORING ORDER (header + items + measurements + fabric + photos)
///////////////////////////////////////////////////////
router.post('/', upload.any(), async (req, res) => {
    const conn = await pool.getConnection();
    try {
        let raw;
        try {
            raw = JSON.parse(req.body.payload || '{}');
        } catch {
            return res.status(400).json({ message: 'payload ไม่ถูกต้อง' });
        }
        const { header, items } = raw;

        if (!header?.customerName || !header?.deadline || !Array.isArray(items) || !items.length) {
            return res.status(400).json({ message: 'กรุณากรอกชื่อลูกค้า วันที่ต้องส่งงาน และอย่างน้อย 1 ชิ้นงาน' });
        }

        /* เบอร์ลูกค้าต้องครบ 10 หลัก (ไม่กรอกได้ แต่กรอกแล้วต้องถูก) */
        const phone = normalizePhone(header.customerPhone, { label: 'เบอร์โทรลูกค้า' });
        if (!phone.ok) return res.status(400).json({ message: phone.message });

        const filesByField = {};
        (req.files || []).forEach((f) => { filesByField[f.fieldname] = f; });

        await conn.beginTransaction();

        const [orderResult] = await conn.query(
            `INSERT INTO tailoring_orders
                (order_code, order_number, customer_name, customer_phone, order_date, deadline, fitting_date,
                 deposit, deposit_payment_method, created_by, bill_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                header.orderCode, header.orderNumber || null, header.customerName, phone.value,
                header.orderDate, header.deadline, header.fittingDate || null, Number(header.deposit) || 0,
                header.depositPaymentMethod || null,
                header.createdBy || null, header.billId || null,
            ]
        );
        const orderId = orderResult.insertId;

        /* วันนัดลองตัวที่กรอกตอนเปิดใบสั่งตัด ให้ลงตารางนัดหมายด้วย
           ไม่งั้นปฏิทินนัดจะไม่เห็นนัดของออเดอร์ที่เพิ่งสร้าง */
        if (header.fittingDate) {
            await conn.query(
                `INSERT INTO tailoring_order_appointments
                    (order_id, appointment_date, appointment_time, purpose, note, done)
                 VALUES (?, ?, ?, 'ลองชุด', NULL, 0)`,
                [orderId, header.fittingDate, header.fittingTime ? String(header.fittingTime).slice(0, 5) : null]
            );
        }

        for (let i = 0; i < items.length; i++) {
            const it = items[i];

            const [itemResult] = await conn.query(
                `INSERT INTO tailoring_order_items
                    (order_id, piece_no, garment_type, subtype, suit_mode, suit_bottom, status, fabric_source,
                     fabric_name, fabric_type, fabric_color, fabric_pattern, fabric_prewashed,
                     allowance_type, allowance_special_note, allowance_cannot_allow, allowance_cannot_allow_note,
                     price, fabric_issued_meters)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orderId, i + 1, it.garmentType, it.subtype || null, it.suitMode || null, it.suitBottom || null,
                    it.status, it.fabricSource,
                    it.fabric?.fabricName || null, it.fabric?.fabricType || null, it.fabric?.colorName || null,
                    it.fabric?.patternName || null, it.fabric?.prewashed || null,
                    it.allowancePlan?.type || 'ปกติ', it.allowancePlan?.specialNote || null,
                    it.allowancePlan?.cannotAllow ? 1 : 0, it.allowancePlan?.cannotAllowNote || null,
                    Number(it.price) || 0,
                    it.fabricSource === 'shop' ? (Number(it.shopFabric?.metersIssued) || null) : null,
                ]
            );
            const itemId = itemResult.insertId;

            for (const m of it.measurements || []) {
                if (!m.field_label) continue;
                await conn.query(
                    `INSERT INTO tailoring_order_measurements (item_id, field_key, field_label, current_cm, min_cm, max_cm, is_custom)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [itemId, m.field_key || null, m.field_label, m.current_cm || null, m.min_cm || null, m.max_cm || null, m.is_custom ? 1 : 0]
                );
            }

            for (const [seamKey, val] of Object.entries(it.seamAllowance || {})) {
                if (val === '' || val === null || val === undefined) continue;
                await conn.query(
                    `INSERT INTO tailoring_order_seam_allowance (item_id, seam_key, allowance_cm) VALUES (?, ?, ?)`,
                    [itemId, seamKey, Number(val)]
                );
            }

            if (it.fabricSource === 'shop' && it.shopFabric?.rollId) {
                await conn.query(
                    `INSERT INTO tailoring_order_shop_fabric (item_id, roll_id, price_per_meter, meters_issued)
                     VALUES (?, ?, ?, ?)`,
                    [itemId, it.shopFabric.rollId, Number(it.shopFabric.pricePerMeter) || null, Number(it.shopFabric.metersIssued) || null]
                );
            }

            if (it.fabricSource === 'customer' && it.customerFabric) {
                const cf = it.customerFabric;
                await conn.query(
                    `INSERT INTO tailoring_order_customer_fabric
                        (item_id, received_date, roll_count, measured_length, measured_width, condition_note, washed, acknowledged, enough, adjustment_note, return_scraps)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        itemId, cf.receivedDate || null, Number(cf.rollCount) || null, Number(cf.measuredLength) || null,
                        Number(cf.measuredWidth) || null, cf.condition || null, cf.washed || null, cf.acknowledged ? 1 : 0,
                        cf.enough || null, cf.adjustmentNote || null, cf.returnScraps || null,
                    ]
                );
            }

            const photoDescs = (raw.photos || []).filter((p) => p.itemClientId === it.clientId);
            for (const p of photoDescs) {
                const file = filesByField[`file_${p.clientId}`];
                if (!file) continue;
                await conn.query(
                    `INSERT INTO tailoring_order_photos (item_id, photo_type, file_path) VALUES (?, ?, ?)`,
                    [itemId, p.type, `/uploads/${file.filename}`]
                );
            }
        }

        await conn.commit();
        res.status(201).json({ message: 'บันทึกใบสั่งตัดชุดแล้ว', order_id: orderId, order_code: header.orderCode });
    } catch (err) {
        await conn.rollback();
        console.error('Error creating tailoring order:', err);
        (req.files || []).forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* ignore */ } });
        res.status(500).json({ message: 'บันทึกใบสั่งตัดไม่สำเร็จ' });
    } finally {
        conn.release();
    }
});

///////////////////////////////////////////////////////
//// UPDATE TAILORING ORDER — สถานะ / ขนาดตัว / ผ้าที่ใช้จริง /
//// ประวัติการแก้ไข (พร้อมค่าใช้จ่าย) / วันนัดถัดไป
//// รับก้อนเดียวจากหน้ารายละเอียด แล้วเขียนทับใน transaction เดียว
///////////////////////////////////////////////////////
router.put('/:id', async (req, res) => {
    const orderId = Number(req.params.id);
    const { items = [], appointments = [], fitting_date, customer_name, customer_phone } = req.body || {};

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [[order]] = await conn.query(
            'SELECT order_id FROM tailoring_orders WHERE order_id = ? AND deleted_at IS NULL',
            [orderId]
        );
        if (!order) {
            await conn.rollback();
            return res.status(404).json({ message: 'ไม่พบใบสั่งตัดนี้' });
        }

        /* ── ข้อมูลลูกค้า: ชื่อ-นามสกุล และเบอร์โทร ── */
        if (customer_name !== undefined || customer_phone !== undefined) {
            const sets = [];
            const vals = [];

            if (customer_name !== undefined) {
                const name = String(customer_name || '').trim();
                if (!name) {
                    await conn.rollback();
                    return res.status(400).json({ message: 'กรุณากรอกชื่อ-นามสกุลลูกค้า' });
                }
                sets.push('customer_name = ?');
                vals.push(name);
            }

            if (customer_phone !== undefined) {
                const phone = normalizePhone(customer_phone, { label: 'เบอร์โทรลูกค้า' });
                if (!phone.ok) {
                    await conn.rollback();
                    return res.status(400).json({ message: phone.message });
                }
                sets.push('customer_phone = ?');
                vals.push(phone.value);
            }

            await conn.query(
                `UPDATE tailoring_orders SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
                [...vals, orderId]
            );
        }

        /* ── ชิ้นงาน: สถานะ, ผ้าที่ใช้จริง, ขนาดตัว, ประวัติการแก้ไข ── */
        for (const it of items) {
            const itemId = Number(it.item_id);
            if (!itemId) continue;

            // กันแก้ชิ้นงานที่ไม่ได้อยู่ในใบสั่งตัดนี้
            const [[owned]] = await conn.query(
                'SELECT item_id FROM tailoring_order_items WHERE item_id = ? AND order_id = ? AND deleted_at IS NULL',
                [itemId, orderId]
            );
            if (!owned) continue;

            await conn.query(
                `UPDATE tailoring_order_items
                    SET status = COALESCE(?, status),
                        fabric_issued_meters = ?,
                        fabric_used_meters = ?,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE item_id = ?`,
                [
                    it.status || null,
                    it.fabric_issued_meters === '' || it.fabric_issued_meters == null ? null : Number(it.fabric_issued_meters),
                    it.fabric_used_meters === '' || it.fabric_used_meters == null ? null : Number(it.fabric_used_meters),
                    itemId,
                ]
            );

            if (Array.isArray(it.measurements)) {
                await conn.query('DELETE FROM tailoring_order_measurements WHERE item_id = ?', [itemId]);
                for (const m of it.measurements) {
                    if (!m.field_label) continue;
                    await conn.query(
                        `INSERT INTO tailoring_order_measurements
                            (item_id, field_key, field_label, current_cm, min_cm, max_cm, is_custom)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [
                            itemId, m.field_key || null, m.field_label,
                            m.current_cm === '' || m.current_cm == null ? null : Number(m.current_cm),
                            m.min_cm === '' || m.min_cm == null ? null : Number(m.min_cm),
                            m.max_cm === '' || m.max_cm == null ? null : Number(m.max_cm),
                            m.is_custom ? 1 : 0,
                        ]
                    );
                }
            }

            if (Array.isArray(it.alterations)) {
                await conn.query('DELETE FROM tailoring_order_alterations WHERE item_id = ?', [itemId]);
                for (const a of it.alterations) {
                    if (!a.alteration_date && !a.point && !a.fee_amount) continue;
                    await conn.query(
                        `INSERT INTO tailoring_order_alterations
                            (item_id, alteration_date, point, adjust_cm, remaining_allowance, fee_amount)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            itemId, a.alteration_date || null, a.point || null,
                            a.adjust_cm || null, a.remaining_allowance || null,
                            Number(a.fee_amount) || 0,
                        ]
                    );
                }
            }
        }

        /* ── วันนัด: เขียนทับทั้งชุด ── */
        if (Array.isArray(appointments)) {
            await conn.query('DELETE FROM tailoring_order_appointments WHERE order_id = ?', [orderId]);
            for (const a of appointments) {
                if (!a.appointment_date || !a.purpose) continue;
                /* เวลานัดไม่บังคับ — ว่างไว้ = นัดไว้แต่ยังไม่ระบุเวลา */
                const apptTime = a.appointment_time ? String(a.appointment_time).slice(0, 5) : null;
                await conn.query(
                    `INSERT INTO tailoring_order_appointments
                        (order_id, appointment_date, appointment_time, purpose, note, done)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [orderId, a.appointment_date, apptTime, a.purpose, a.note || null, a.done ? 1 : 0]
                );
            }

            /* fitting_date เดิมยังใช้แสดงในบางหน้า — sync ให้ตรงกับนัดลองชุดถัดไป */
            const nextFitting = appointments
                .filter((a) => !a.done && a.appointment_date && /ลองชุด/.test(a.purpose || ''))
                .map((a) => a.appointment_date)
                .sort()[0] || null;
            await conn.query(
                'UPDATE tailoring_orders SET fitting_date = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?',
                [fitting_date !== undefined ? fitting_date : nextFitting, orderId]
            );
        }

        await conn.commit();
        res.json({ message: 'บันทึกการอัปเดตแล้ว' });
    } catch (err) {
        await conn.rollback();
        console.error('Error updating tailoring order:', err);
        res.status(500).json({ message: 'บันทึกการอัปเดตไม่สำเร็จ' });
    } finally {
        conn.release();
    }
});

///////////////////////////////////////////////////////
//// PHOTOS — ภาพร่าง/แบบแนบ และรูปสภาพผ้าลูกค้า (เพิ่ม/เปลี่ยน/ลบ)
///////////////////////////////////////////////////////

const PHOTO_TYPES = ['design', 'customer_fabric'];

const removeUploadFile = (filePath) => {
    if (!filePath || !filePath.startsWith('/uploads/')) return;
    const abs = path.join(UPLOAD_DIR, path.basename(filePath));
    try { fs.unlinkSync(abs); } catch { /* ไฟล์หายไปแล้วก็ไม่เป็นไร */ }
};

/* หารูปพร้อมเช็คว่าอยู่ในใบสั่งตัดใบนี้จริง */
const findPhotoOfOrder = async (orderId, photoId) => {
    const [[photo]] = await pool.query(
        `SELECT p.photo_id, p.item_id, p.photo_type, p.file_path
           FROM tailoring_order_photos p
           JOIN tailoring_order_items i ON i.item_id = p.item_id
          WHERE p.photo_id = ? AND i.order_id = ? AND i.deleted_at IS NULL`,
        [photoId, orderId]
    );
    return photo || null;
};

/* เพิ่มรูปเข้าชิ้นงาน — ส่งได้หลายไฟล์ในครั้งเดียว (field name: photos) */
router.post('/:id/items/:itemId/photos', upload.array('photos', 10), async (req, res) => {
    const orderId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const photoType = PHOTO_TYPES.includes(req.body.photo_type) ? req.body.photo_type : 'design';
    const files = req.files || [];

    try {
        if (!files.length) return res.status(400).json({ message: 'กรุณาเลือกรูปอย่างน้อย 1 รูป' });

        const [[owned]] = await pool.query(
            `SELECT i.item_id FROM tailoring_order_items i
              JOIN tailoring_orders t ON t.order_id = i.order_id
             WHERE i.item_id = ? AND i.order_id = ? AND i.deleted_at IS NULL AND t.deleted_at IS NULL`,
            [itemId, orderId]
        );
        if (!owned) {
            files.forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* ignore */ } });
            return res.status(404).json({ message: 'ไม่พบชิ้นงานนี้ในใบสั่งตัด' });
        }

        const created = [];
        for (const file of files) {
            const filePath = `/uploads/${file.filename}`;
            const [result] = await pool.query(
                `INSERT INTO tailoring_order_photos (item_id, photo_type, file_path) VALUES (?, ?, ?)`,
                [itemId, photoType, filePath]
            );
            created.push({ photo_id: result.insertId, item_id: itemId, photo_type: photoType, file_path: filePath });
        }

        res.status(201).json({ message: 'เพิ่มรูปแล้ว', photos: created });
    } catch (err) {
        console.error('Error adding tailoring photos:', err);
        files.forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* ignore */ } });
        res.status(500).json({ message: 'เพิ่มรูปไม่สำเร็จ' });
    }
});

/* เปลี่ยนรูปเดิมเป็นรูปใหม่ (field name: photo) — ไฟล์เก่าถูกลบทิ้ง */
router.put('/:id/photos/:photoId', upload.single('photo'), async (req, res) => {
    const orderId = Number(req.params.id);
    const photoId = Number(req.params.photoId);
    const file = req.file;

    try {
        if (!file) return res.status(400).json({ message: 'กรุณาเลือกรูปใหม่' });

        const photo = await findPhotoOfOrder(orderId, photoId);
        if (!photo) {
            try { fs.unlinkSync(file.path); } catch { /* ignore */ }
            return res.status(404).json({ message: 'ไม่พบรูปนี้ในใบสั่งตัด' });
        }

        const filePath = `/uploads/${file.filename}`;
        await pool.query(
            'UPDATE tailoring_order_photos SET file_path = ?, uploaded_at = CURRENT_TIMESTAMP WHERE photo_id = ?',
            [filePath, photoId]
        );
        removeUploadFile(photo.file_path);

        res.json({
            message: 'เปลี่ยนรูปแล้ว',
            photo: { photo_id: photoId, item_id: photo.item_id, photo_type: photo.photo_type, file_path: filePath },
        });
    } catch (err) {
        console.error('Error replacing tailoring photo:', err);
        if (file) { try { fs.unlinkSync(file.path); } catch { /* ignore */ } }
        res.status(500).json({ message: 'เปลี่ยนรูปไม่สำเร็จ' });
    }
});

/* ลบรูป */
router.delete('/:id/photos/:photoId', async (req, res) => {
    const orderId = Number(req.params.id);
    const photoId = Number(req.params.photoId);

    try {
        const photo = await findPhotoOfOrder(orderId, photoId);
        if (!photo) return res.status(404).json({ message: 'ไม่พบรูปนี้ในใบสั่งตัด' });

        await pool.query('DELETE FROM tailoring_order_photos WHERE photo_id = ?', [photoId]);
        removeUploadFile(photo.file_path);

        res.json({ message: 'ลบรูปแล้ว' });
    } catch (err) {
        console.error('Error deleting tailoring photo:', err);
        res.status(500).json({ message: 'ลบรูปไม่สำเร็จ' });
    }
});

///////////////////////////////////////////////////////
//// SETTLE — รับชำระส่วนที่เหลือตอนลูกค้ามารับชุด
//// (ตอนเปิดบิลเก็บแค่มัดจำ ที่เหลือมาเก็บวันรับของ)
///////////////////////////////////////////////////////
router.put('/:id/settle', upload.single('slip'), async (req, res) => {
    try {
        const { amount, payment_method } = req.body || {};
        if (amount == null || amount === '' || Number.isNaN(Number(amount)) || Number(amount) < 0) {
            if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
            return res.status(400).json({ message: 'จำนวนเงินไม่ถูกต้อง' });
        }

        /* รูปสลิป/หลักฐานการชำระเงิน — ถ้าไม่แนบมาก็เก็บของเดิมไว้ */
        const slipPath = req.file ? `/uploads/${req.file.filename}` : null;

        const [result] = await pool.query(
            `UPDATE tailoring_orders
                SET final_paid_amount = ?, final_payment_method = ?,
                    final_paid_at = NOW(),
                    final_payment_slip = COALESCE(?, final_payment_slip),
                    updated_at = CURRENT_TIMESTAMP
              WHERE order_id = ? AND deleted_at IS NULL`,
            [Number(amount), payment_method || null, slipPath, req.params.id]
        );
        if (!result.affectedRows) {
            if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
            return res.status(404).json({ message: 'ไม่พบใบสั่งตัดนี้' });
        }

        res.json({ message: 'รับชำระส่วนที่เหลือแล้ว', slip: slipPath });
    } catch (err) {
        console.error('Error settling tailoring order:', err);
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// SOFT DELETE TAILORING ORDER
///////////////////////////////////////////////////////
router.delete('/:id', async (req, res) => {
    try {
        const [result] = await pool.query(
            `UPDATE tailoring_orders SET deleted_at = NOW() WHERE order_id = ? AND deleted_at IS NULL`,
            [req.params.id]
        );
        if (!result.affectedRows) return res.status(404).json({ message: 'ไม่พบใบสั่งตัดนี้' });
        res.json({ message: 'ลบใบสั่งตัดแล้ว' });
    } catch (err) {
        console.error('Error deleting tailoring order:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// LINK TAILORING ORDER TO A SALE BILL (เชื่อมเป็นออเดอร์เดียวกัน)
///////////////////////////////////////////////////////
router.put('/:id/link-bill', async (req, res) => {
    try {
        const { bill_id } = req.body || {};
        if (!bill_id) return res.status(400).json({ message: 'ต้องระบุ bill_id' });

        const [result] = await pool.query(
            `UPDATE tailoring_orders SET bill_id = ? WHERE order_id = ? AND deleted_at IS NULL`,
            [bill_id, req.params.id]
        );
        if (!result.affectedRows) return res.status(404).json({ message: 'ไม่พบคำสั่งตัดชุดนี้' });
        res.json({ message: 'เชื่อมกับบิลแล้ว' });
    } catch (err) {
        console.error('Error linking tailoring order to bill:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
