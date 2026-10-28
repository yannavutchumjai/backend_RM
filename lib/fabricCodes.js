// ออกรหัสผ้า / รหัสล็อต / รหัสม้วน อัตโนมัติ
//   รหัสผ้า  S01F003         (ร้าน 01 ผ้าลำดับที่ 3 ของร้าน)
//   รหัสล็อต S01F003-L02     (ล็อตที่ 2 ของผ้านี้)
//   รหัสม้วน S01F003-L02-1   (ม้วนที่ 1 ของล็อตนี้)
// ผ้า 1 รายการ = ผู้จัดจำหน่าย + ประเภทผ้า + ลวดลาย + สี

const pad = (n, len) => String(n).padStart(len, '0');

const lotNumberOf = (fabricCode, lotNo) => `${fabricCode}-L${pad(lotNo, 2)}`;
const rollCodeOf = (lotNumber, rollNo) => `${lotNumber}-${rollNo}`;

// conn = pool หรือ connection ใน transaction
// lock = true เมื่อเรียกใน transaction ก่อน INSERT (กันออกรหัสซ้ำเวลาบันทึกพร้อมกัน)
async function findFabricBySpec(conn, { supplier_id, type_id, category_id, color_id }, lock = false) {
    const [rows] = await conn.query(`
        SELECT fabric_id, fabric_code, fabric_name, width_cm, image_path, deleted_at
        FROM fabrics
        WHERE supplier_id = ? AND type_id = ? AND category_id = ? AND color_id = ?
        LIMIT 1
        ${lock ? 'FOR UPDATE' : ''}
    `, [supplier_id, type_id, category_id, color_id]);
    return rows[0] || null;
}

async function nextFabricCode(conn, supplierId) {
    const [rows] = await conn.query(`
        SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(fabric_code, 'F', -1) AS UNSIGNED)), 0) AS last_no
        FROM fabrics
        WHERE supplier_id = ?
    `, [supplierId]);
    return `S${pad(supplierId, 2)}F${pad(Number(rows[0].last_no) + 1, 3)}`;
}

// นับรวมม้วนที่ลบไปแล้วด้วย เพื่อไม่ให้รหัสล็อตเก่าถูกใช้ซ้ำ
async function nextLotNo(conn, fabricId) {
    const [rows] = await conn.query(
        'SELECT COALESCE(MAX(lot_no), 0) AS last_no FROM fabric_rolls WHERE fabric_id = ?',
        [fabricId]
    );
    return Number(rows[0].last_no) + 1;
}

// ใช้ทั้งตอนแสดงตัวอย่างรหัสบนฟอร์ม และตอนบันทึกจริง
async function previewCodes(conn, spec, lock = false) {
    const fabric = await findFabricBySpec(conn, spec, lock);
    const fabricCode = fabric?.fabric_code || await nextFabricCode(conn, spec.supplier_id);
    const lotNo = fabric ? await nextLotNo(conn, fabric.fabric_id) : 1;
    const lotNumber = lotNumberOf(fabricCode, lotNo);

    return {
        fabric,
        fabric_code: fabricCode,
        lot_no: lotNo,
        lot_number: lotNumber,
        roll_no: 1,
        roll_code: rollCodeOf(lotNumber, 1),
    };
}

// ชื่อผ้า = ประเภทผ้า + ลวดลาย + สี (ต่อกันไม่เว้นวรรค)
async function fabricNameOf(conn, { type_id, category_id, color_id }) {
    const [[names]] = await conn.query(`
        SELECT
            (SELECT type_name FROM fabric_types WHERE type_id = ?) AS type_name,
            (SELECT category_name FROM category WHERE category_id = ?) AS category_name,
            (SELECT color_name FROM Color WHERE color_id = ?) AS color_name
    `, [type_id, category_id, color_id]);
    return [names.type_name, names.category_name, names.color_name].filter(Boolean).join('');
}

// หน้ากว้าง (ซม.) ที่ส่งมา: ว่าง/ไม่ใช่ตัวเลข/ไม่เกิน 0 → ถือว่าไม่ได้ระบุ
const toWidth = (value) => {
    const n = Number(value);
    return value !== '' && value != null && n > 0 ? n : null;
};

// หาผ้าของร้านตามสเปก ถ้าไม่มีสร้างใหม่ ถ้าเคยลบไปแล้วคืนสถานะ
// ผ้าเดิมที่ยังไม่มีหน้ากว้าง → เติมให้ถ้าส่งมา (ไม่เขียนทับค่าที่มีอยู่แล้ว)
// ต้องเรียกใน transaction และล็อกแถว suppliers ของร้านนั้นไว้ก่อน
async function ensureFabric(conn, spec, { fabricName, imagePath, widthCm } = {}) {
    const existing = await findFabricBySpec(conn, spec, true);
    const width = toWidth(widthCm);

    if (existing) {
        const fillWidth = existing.width_cm == null && width != null;
        if (existing.deleted_at || imagePath || fillWidth) {
            await conn.query(`
                UPDATE fabrics
                SET deleted_at = NULL,
                    status = 'active',
                    image_path = COALESCE(?, image_path),
                    width_cm = COALESCE(width_cm, ?)
                WHERE fabric_id = ?
            `, [imagePath || null, width, existing.fabric_id]);
        }
        return { ...existing, width_cm: existing.width_cm ?? width, created: false };
    }

    const fabricCode = await nextFabricCode(conn, spec.supplier_id);
    const name = (fabricName || '').trim() || await fabricNameOf(conn, spec);
    const [ins] = await conn.query(`
        INSERT INTO fabrics
        (supplier_id, fabric_code, fabric_name, type_id, category_id, color_id, width_cm, image_path, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `, [spec.supplier_id, fabricCode, name, spec.type_id, spec.category_id, spec.color_id, width, imagePath || null]);

    return {
        fabric_id: ins.insertId,
        fabric_code: fabricCode,
        fabric_name: name,
        width_cm: width,
        image_path: imagePath || null,
        created: true,
    };
}

// สร้างม้วนผ้า 1 ม้วน + บันทึกราคาต่อเมตรไว้เปรียบเทียบราคา
async function insertRoll(conn, {
    fabric, spec, lotNo, rollNo, length, totalPrice,
    purchaseDate = null, storageLocation = null, poItemId = null,
}) {
    const lotNumber = lotNumberOf(fabric.fabric_code, lotNo);
    const rollCode = rollCodeOf(lotNumber, rollNo);
    const costPerMeter = totalPrice / length;

    const [roll] = await conn.query(`
        INSERT INTO fabric_rolls (
            roll_code, fabric_id, supplier_id, po_item_id, lot_number, lot_no, roll_no,
            storage_location, initial_length, remaining_length,
            purchase_total_price, cost_per_meter, purchase_date, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), 'normal')
    `, [
        rollCode, fabric.fabric_id, spec.supplier_id, poItemId, lotNumber, lotNo, rollNo,
        storageLocation, length, length, totalPrice, costPerMeter, purchaseDate
    ]);

    await conn.query(`
        INSERT INTO supplier_fabric_prices
        (supplier_id, fabric_id, type_id, category_id, color_id,
         price_per_meter, source, roll_id, price_date)
        VALUES (?, ?, ?, ?, ?, ?, 'purchase', ?, COALESCE(?, CURDATE()))
    `, [
        spec.supplier_id, fabric.fabric_id, spec.type_id, spec.category_id, spec.color_id,
        costPerMeter, roll.insertId, purchaseDate
    ]);

    return { roll_id: roll.insertId, roll_code: rollCode, lot_number: lotNumber };
}

module.exports = {
    lotNumberOf,
    rollCodeOf,
    toWidth,
    findFabricBySpec,
    nextFabricCode,
    nextLotNo,
    previewCodes,
    fabricNameOf,
    ensureFabric,
    insertRoll,
};
