const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
    previewCodes, ensureFabric, insertRoll, nextLotNo, toWidth,
    findFabricBySpec, lotNumberOf, rollCodeOf,
} = require('../lib/fabricCodes');

// ม้วนเริ่มใช้งานแล้ว = ความยาวลดลง หรือมีประวัติการใช้/ผลคำนวณ/ออเดอร์ตัดชุดอ้างถึง
const USED_SQL = `(
    fr.remaining_length < fr.initial_length
    OR EXISTS (SELECT 1 FROM fabric_usage_logs u WHERE u.roll_id = fr.roll_id AND u.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM fabric_calc_usage_logs cu WHERE cu.roll_id = fr.roll_id)
    OR EXISTS (SELECT 1 FROM tailoring_order_shop_fabric t WHERE t.roll_id = fr.roll_id)
)`;

// ใช้โฟลเดอร์ uploads เดียวกับ fabric.routes.js
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const filename = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
        cb(null, filename);
    }
});

const upload = multer({ storage });
const publicPath = (filename) => filename ? `/uploads/${filename}` : null;

///////////////////////////////////////////////////////
//// GET FABRIC TYPES (ต้องอยู่ก่อน /:id)
///////////////////////////////////////////////////////
router.get('/fabric-types', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT type_id, type_name
            FROM fabric_types
            WHERE deleted_at IS NULL
            ORDER BY type_id ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching fabric types:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// ผ้าที่ผู้จัดจำหน่ายรายนี้เคยมี (ใช้กรอง ประเภท/ลวดลาย/สี บนฟอร์มเพิ่มม้วนผ้า)
///////////////////////////////////////////////////////
router.get('/supplier-fabrics/:supplierId', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                f.fabric_id, f.fabric_code, f.fabric_name, f.image_path,
                f.type_id, ft.type_name,
                f.category_id, c.category_name,
                f.color_id, col.color_name,
                (SELECT MAX(fr.lot_no) FROM fabric_rolls fr WHERE fr.fabric_id = f.fabric_id) AS last_lot_no
            FROM fabrics f
            LEFT JOIN fabric_types ft ON f.type_id     = ft.type_id
            LEFT JOIN category c      ON f.category_id = c.category_id
            LEFT JOIN Color col       ON f.color_id    = col.color_id
            WHERE f.supplier_id = ? AND f.deleted_at IS NULL
            ORDER BY f.fabric_code
        `, [req.params.supplierId]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching supplier fabrics:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// ตัวอย่างรหัสผ้า/ล็อต/ม้วน ถัดไป (แสดงบนฟอร์ม — รหัสจริงออกตอนบันทึก)
///////////////////////////////////////////////////////
router.get('/next-code', async (req, res) => {
    const spec = {
        supplier_id: Number(req.query.supplier_id),
        type_id: Number(req.query.type_id),
        category_id: Number(req.query.category_id),
        color_id: Number(req.query.color_id),
    };
    if (Object.values(spec).some((v) => !v)) {
        return res.status(400).json({ message: 'supplier_id, type_id, category_id, color_id are required' });
    }

    try {
        const { fabric, ...codes } = await previewCodes(pool, spec);
        res.json({
            ...codes,
            fabric_id: fabric && !fabric.deleted_at ? fabric.fabric_id : null,
            fabric_name: fabric?.fabric_name || null,
            width_cm: fabric?.width_cm ?? null,
            image_path: fabric?.image_path || null,
            is_new_fabric: !fabric || !!fabric.deleted_at,
        });
    } catch (err) {
        console.error('Error previewing roll code:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// รับม้วนผ้าเข้าคลัง (หา/สร้างผ้าของร้าน + ออกรหัสล็อต/ม้วน + บันทึกราคา)
///////////////////////////////////////////////////////
router.post('/receive', upload.single('image'), async (req, res) => {
    const spec = {
        supplier_id: Number(req.body.supplier_id),
        type_id: Number(req.body.type_id),
        category_id: Number(req.body.category_id),
        color_id: Number(req.body.color_id),
    };
    const initialLength = Number(req.body.initial_length);
    const totalPrice = Number(req.body.purchase_total_price);
    const purchaseDate = req.body.purchase_date || null;
    const storageLocation = req.body.storage_location || null;
    const imagePath = req.file ? publicPath(req.file.filename) : null;

    if (Object.values(spec).some((v) => !v) || !(initialLength > 0) || !(totalPrice >= 0)) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: 'ข้อมูลไม่ครบ: ผู้จัดจำหน่าย ประเภทผ้า ลวดลาย สี ความยาว และราคา' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // ล็อกแถวผู้จัดจำหน่าย ให้การออกรหัสของร้านเดียวกันทำทีละรายการ
        const [sup] = await connection.query(
            'SELECT supplier_id FROM suppliers WHERE supplier_id = ? AND deleted_at IS NULL FOR UPDATE',
            [spec.supplier_id]
        );
        if (!sup.length) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ message: 'ไม่พบผู้จัดจำหน่าย' });
        }

        // ผ้าของร้านตามสเปก (ไม่มี → สร้างใหม่ พร้อมชื่อ = ประเภท+ลวดลาย+สี)
        const fabric = await ensureFabric(connection, spec, {
            fabricName: req.body.fabric_name,
            imagePath,
            widthCm: req.body.width_cm,
        });

        // หน้ากว้างใช้คำนวณว่าผ้าพอตัดชุดไหม → ผ้าทุกแบบต้องมี
        if (fabric.width_cm == null) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'กรุณากรอกหน้ากว้างของผ้า' });
        }

        const roll = await insertRoll(connection, {
            fabric,
            spec,
            lotNo: await nextLotNo(connection, fabric.fabric_id),
            rollNo: 1,
            length: initialLength,
            totalPrice,
            purchaseDate,
            storageLocation,
        });

        await connection.commit();
        res.status(201).json({
            message: 'Roll received',
            roll_id: roll.roll_id,
            fabric_id: fabric.fabric_id,
            fabric_name: fabric.fabric_name,
            fabric_code: fabric.fabric_code,
            lot_number: roll.lot_number,
            roll_code: roll.roll_code,
        });
    } catch (err) {
        await connection.rollback();
        console.error('Error receiving fabric roll:', err);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ message: 'Server error' });
    } finally {
        connection.release();
    }
});

///////////////////////////////////////////////////////
//// GET ALL FABRIC ROLLS (Join ทุกตาราง)
///////////////////////////////////////////////////////
router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                fr.*,
                f.fabric_name,
                f.fabric_code,
                f.width_cm,
                f.image_path,
                f.type_id,
                f.color_id,
                f.category_id,
                c.category_name,
                ft.type_name,
                col.color_name,
                s.supplier_name
            FROM fabric_rolls fr
            LEFT JOIN fabrics f       ON fr.fabric_id   = f.fabric_id
            LEFT JOIN category c      ON f.category_id  = c.category_id
            LEFT JOIN fabric_types ft ON f.type_id      = ft.type_id
            LEFT JOIN Color col       ON f.color_id     = col.color_id
            LEFT JOIN suppliers s     ON fr.supplier_id = s.supplier_id
            WHERE fr.deleted_at IS NULL
            ORDER BY fr.roll_id DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching fabric rolls:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// GET FABRIC ROLL BY ID
///////////////////////////////////////////////////////
router.get('/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                fr.*,
                f.fabric_name,
                f.fabric_code,
                f.width_cm,
                f.image_path,
                f.type_id,
                f.color_id,
                f.category_id,
                c.category_name,
                ft.type_name,
                col.color_name,
                s.supplier_name,
                ${USED_SQL} AS is_used
            FROM fabric_rolls fr
            LEFT JOIN fabrics f       ON fr.fabric_id   = f.fabric_id
            LEFT JOIN category c      ON f.category_id  = c.category_id
            LEFT JOIN fabric_types ft ON f.type_id      = ft.type_id
            LEFT JOIN Color col       ON f.color_id     = col.color_id
            LEFT JOIN suppliers s     ON fr.supplier_id = s.supplier_id
            WHERE fr.roll_id = ? AND fr.deleted_at IS NULL
        `, [req.params.id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Fabric roll not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// CREATE FABRIC ROLL
///////////////////////////////////////////////////////
router.post('/', async (req, res) => {
    try {
        const {
            roll_code, fabric_id, supplier_id, lot_number,
            storage_location, initial_length, remaining_length,
            purchase_total_price, cost_per_meter, purchase_date, status
        } = req.body;

        const [result] = await pool.query(`
            INSERT INTO fabric_rolls (
                roll_code, fabric_id, supplier_id, lot_number,
                storage_location, initial_length, remaining_length,
                purchase_total_price, cost_per_meter, purchase_date, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            roll_code, fabric_id, supplier_id, lot_number,
            storage_location, initial_length, remaining_length,
            purchase_total_price, cost_per_meter, purchase_date,
            status || 'normal'
        ]);

        res.status(201).json({ message: 'Roll created', roll_id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

///////////////////////////////////////////////////////
//// UPDATE FABRIC ROLL
////   แก้ได้เสมอ: ชื่อผ้า / หน้ากว้าง / รูป (เป็นของผ้าแบบนี้ ทุกม้วนเห็นตาม), วันที่ซื้อ, คลังที่จัดเก็บ
////   แก้ได้เฉพาะม้วนที่ยังไม่เริ่มใช้งาน:
////     - ผู้จัดจำหน่าย/ประเภท/ลวดลาย/สี → ย้ายม้วนไปผ้าแบบใหม่ ออกรหัสล็อต/ม้วนใหม่
////       (ม้วนที่มาจากใบสั่งซื้อเปลี่ยนไม่ได้ เพราะต้องตรงกับใบสั่งซื้อ)
////     - ความยาวเริ่มต้น / ราคาซื้อรวมทั้งม้วน → คำนวณราคาต่อเมตรใหม่
///////////////////////////////////////////////////////
router.put('/:id', upload.single('image'), async (req, res) => {
    const connection = await pool.getConnection();
    const fail = async (status, message) => {
        await connection.rollback();
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(status).json({ message });
    };

    try {
        await connection.beginTransaction();

        const [rows] = await connection.query(`
            SELECT
                fr.*,
                f.fabric_name,
                f.type_id,
                f.color_id,
                f.category_id,
                f.width_cm,
                f.image_path,
                ${USED_SQL} AS is_used
            FROM fabric_rolls fr
            LEFT JOIN fabrics f ON fr.fabric_id = f.fabric_id
            WHERE fr.roll_id = ? AND fr.deleted_at IS NULL
            LIMIT 1
            FOR UPDATE
        `, [req.params.id]);

        if (!rows.length) return fail(404, 'Fabric roll not found');

        const old = rows[0];
        const used = Number(old.is_used) === 1;
        const body = req.body;
        const uploadedImage = req.file ? publicPath(req.file.filename) : null;

        // หน้ากว้าง: ไม่ส่งมา → คงค่าเดิม / ส่งค่าว่าง → ล้างเป็น NULL
        const nextWidth = body.width_cm === undefined ? old.width_cm : toWidth(body.width_cm);

        const spec = {
            supplier_id: Number(body.supplier_id || old.supplier_id),
            type_id: Number(body.type_id || old.type_id),
            category_id: Number(body.category_id || old.category_id),
            color_id: Number(body.color_id || old.color_id),
        };
        const specChanged =
            spec.supplier_id !== Number(old.supplier_id) ||
            spec.type_id !== Number(old.type_id) ||
            spec.category_id !== Number(old.category_id) ||
            spec.color_id !== Number(old.color_id);

        const nextLength = body.initial_length === undefined ? Number(old.initial_length) : Number(body.initial_length);
        const nextTotal = body.purchase_total_price === undefined
            ? Number(old.purchase_total_price)
            : Number(body.purchase_total_price);
        const costChanged =
            nextLength !== Number(old.initial_length) || nextTotal !== Number(old.purchase_total_price);

        if (specChanged && used) {
            return fail(400, 'ม้วนนี้เริ่มใช้งานแล้ว เปลี่ยนผู้จัดจำหน่าย ประเภทผ้า ลวดลาย สี ไม่ได้');
        }
        if (specChanged && old.po_item_id) {
            return fail(400, 'ม้วนนี้รับเข้าจากใบสั่งซื้อ เปลี่ยนผู้จัดจำหน่าย ประเภทผ้า ลวดลาย สี ไม่ได้');
        }
        if (costChanged && used) {
            return fail(400, 'ม้วนนี้เริ่มใช้งานแล้ว แก้ความยาวเริ่มต้นและราคาซื้อไม่ได้');
        }
        if (costChanged && !(nextLength > 0 && nextTotal >= 0)) {
            return fail(400, 'ความยาวต้องมากกว่า 0 และราคาต้องไม่ติดลบ');
        }

        let fabricId = old.fabric_id;
        let { lot_no: lotNo, roll_no: rollNo, lot_number: lotNumber, roll_code: rollCode } = old;

        if (specChanged) {
            const [sup] = await connection.query(
                'SELECT supplier_id FROM suppliers WHERE supplier_id = ? AND deleted_at IS NULL FOR UPDATE',
                [spec.supplier_id]
            );
            if (!sup.length) return fail(400, 'ไม่พบผู้จัดจำหน่าย');

            // ผ้าปลายทางมีอยู่แล้ว → ใช้ของเดิม (ไม่เอารูป/หน้ากว้างของผ้าเก่าไปทับ)
            // ยังไม่มี → สร้างใหม่ พร้อมรูปและหน้ากว้างของผ้าเก่า
            const target = await findFabricBySpec(connection, spec, true);
            const fabric = await ensureFabric(connection, spec, {
                imagePath: target ? uploadedImage : (uploadedImage || old.image_path),
                widthCm: nextWidth,
            });

            fabricId = fabric.fabric_id;
            lotNo = await nextLotNo(connection, fabricId);
            rollNo = 1;
            lotNumber = lotNumberOf(fabric.fabric_code, lotNo);
            rollCode = rollCodeOf(lotNumber, rollNo);

            // ผ้าเก่าไม่เหลือม้วนแล้ว → ซ่อน (เหมือนตอนลบม้วนสุดท้าย)
            const [[left]] = await connection.query(
                'SELECT COUNT(*) AS n FROM fabric_rolls WHERE fabric_id = ? AND roll_id <> ? AND deleted_at IS NULL',
                [old.fabric_id, old.roll_id]
            );
            if (Number(left.n) === 0) {
                await connection.query(
                    'UPDATE fabrics SET deleted_at = CURRENT_TIMESTAMP WHERE fabric_id = ? AND deleted_at IS NULL',
                    [old.fabric_id]
                );
            }
        } else {
            const nextImage = uploadedImage || (body.removeImage === 'true' ? null : old.image_path);

            await connection.query(`
                UPDATE fabrics
                SET
                    fabric_name = ?,
                    width_cm = ?,
                    image_path = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE fabric_id = ?
            `, [
                (body.fabric_name || '').trim() || old.fabric_name,
                nextWidth,
                nextImage,
                fabricId,
            ]);

            if (nextImage !== old.image_path && old.image_path) {
                const oldFilePath = path.join(UPLOAD_DIR, path.basename(old.image_path));
                if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
            }
        }

        const costPerMeter = costChanged ? nextTotal / nextLength : Number(old.cost_per_meter);

        await connection.query(`
            UPDATE fabric_rolls SET
                fabric_id            = ?,
                supplier_id          = ?,
                roll_code            = ?,
                lot_number           = ?,
                lot_no               = ?,
                roll_no              = ?,
                storage_location     = ?,
                purchase_date        = ?,
                initial_length       = ?,
                remaining_length     = ?,
                purchase_total_price = ?,
                cost_per_meter       = ?,
                updated_at           = CURRENT_TIMESTAMP
            WHERE roll_id = ?
        `, [
            fabricId,
            spec.supplier_id,
            rollCode,
            lotNumber,
            lotNo,
            rollNo,
            body.storage_location ?? old.storage_location,
            body.purchase_date || old.purchase_date,
            costChanged ? nextLength : old.initial_length,
            costChanged ? nextLength : old.remaining_length,
            nextTotal,
            costPerMeter,
            old.roll_id,
        ]);

        // ราคาเปรียบเทียบของม้วนนี้ ให้ตรงกับร้าน/ผ้า/ราคาใหม่
        if (specChanged || costChanged) {
            await connection.query(`
                UPDATE supplier_fabric_prices
                SET supplier_id = ?, fabric_id = ?, type_id = ?, category_id = ?, color_id = ?,
                    price_per_meter = ?
                WHERE roll_id = ?
            `, [
                spec.supplier_id, fabricId, spec.type_id, spec.category_id, spec.color_id,
                costPerMeter, old.roll_id,
            ]);
        }

        await connection.commit();
        res.json({ message: 'Roll updated successfully', roll_code: rollCode });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ message: 'Server error' });
    } finally {
        connection.release();
    }
});

///////////////////////////////////////////////////////
//// SOFT DELETE FABRIC ROLL
///////////////////////////////////////////////////////
// ลบม้วนสุดท้ายของผ้าแบบไหน → ซ่อนผ้าแบบนั้นด้วย (ไม่ขึ้นเป็นตัวเลือกของร้านอีก)
// ถ้าวันหลังเพิ่มสเปกเดิม ensureFabric จะเอาผ้าเดิมกลับมา รหัสเดิม ล็อกต่อจากเดิม
router.delete('/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.query(
            'SELECT fabric_id FROM fabric_rolls WHERE roll_id = ? AND deleted_at IS NULL FOR UPDATE',
            [req.params.id]
        );
        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ message: 'Fabric roll not found' });
        }
        const fabricId = rows[0].fabric_id;

        await connection.query(`
            UPDATE fabric_rolls
            SET
                deleted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE roll_id = ?
        `, [req.params.id]);

        const [[left]] = await connection.query(
            'SELECT COUNT(*) AS n FROM fabric_rolls WHERE fabric_id = ? AND deleted_at IS NULL',
            [fabricId]
        );
        let fabricHidden = false;
        if (Number(left.n) === 0) {
            const [hidden] = await connection.query(
                'UPDATE fabrics SET deleted_at = CURRENT_TIMESTAMP WHERE fabric_id = ? AND deleted_at IS NULL',
                [fabricId]
            );
            fabricHidden = hidden.affectedRows > 0;
        }

        await connection.commit();
        res.json({ message: 'Roll deleted successfully', fabric_hidden: fabricHidden });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        connection.release();
    }
});

module.exports = router;
