const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { normalizePhone } = require('../lib/phone');
const multer = require("multer");
const path = require("path");
const fs = require("fs");

/* ===================================================
   📁 UPLOAD DIRECTORY SETUP (ใช้โฟลเดอร์เดียวกับ users)
=================================================== */
const uploadDir = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});


/* ===============================
GET ALL SUPPLIERS
=============================== */

router.get('/', async (req, res) => {
  try {

    const [rows] = await pool.query(`
      SELECT
        supplier_id,
        supplier_name,
        contact_name,
        email,
        address,
        lat,
        lng,
        phone,
        note,
        image,
        status,
        created_at,
        updated_at
      FROM suppliers
      WHERE deleted_at IS NULL
      ORDER BY supplier_id DESC
    `);

    res.json(rows);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }
});


/* ===============================
GET SUPPLIER DETAIL
=============================== */

router.get('/:id', async (req, res) => {

    try {

        const [rows] = await pool.query(`
        SELECT *
        FROM suppliers
        WHERE supplier_id = ?
        AND deleted_at IS NULL
        `,[req.params.id]);

        if (!rows.length) {

            return res.status(404).json({
                message:"Supplier not found"
            });

        }

        res.json(rows[0]);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            message:"Server error"
        });

    }

});


/* ===============================
CREATE SUPPLIER
=============================== */

router.post('/', upload.single("image"), async (req, res) => {

  try {

    const {
      supplier_name,
      contact_name,
      email,
      address,
      lat,
      lng,
      phone,
      note,
      status
    } = req.body;

    const image = req.file ? req.file.filename : null;

    /* เบอร์โทรต้องเป็นตัวเลข 10 หลัก */
    const phoneCheck = normalizePhone(phone, { label: 'เบอร์โทร' });
    if (!phoneCheck.ok) return res.status(400).json({ message: phoneCheck.message });

    const [result] = await pool.query(`
      INSERT INTO suppliers
      (
        supplier_name,
        contact_name,
        email,
        address,
        lat,
        lng,
        phone,
        note,
        image,
        status
      )
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [
      supplier_name,
      contact_name,
      email,
      address,
      lat || null,
      lng || null,
      phoneCheck.value,
      note,
      image,
      status || 'active'
    ]);

    res.status(201).json({
      message: "Supplier created",
      supplier_id: result.insertId,
      image
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }
});


/* ===============================
UPDATE SUPPLIER
=============================== */

router.put('/:id', upload.single("image"), async (req, res) => {

  try {

    const id = req.params.id;

    const {
      supplier_name,
      contact_name,
      email,
      address,
      lat,
      lng,
      phone,
      note,
      status,
      removeImage
    } = req.body;

    const [existingRows] = await pool.query(
      "SELECT image FROM suppliers WHERE supplier_id = ?",
      [id]
    );

    if (!existingRows.length) {
      return res.status(404).json({
        message: "Supplier not found"
      });
    }

    let image = existingRows[0].image;

    if (req.file) {
      image = req.file.filename;
    } else if (removeImage === "true") {
      image = null;
    }

    if ((req.file || removeImage === "true") && existingRows[0].image) {
      const oldPath = path.join(uploadDir, existingRows[0].image);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    /* ส่งเบอร์มาแก้เมื่อไหร่ ต้องครบ 10 หลัก (ไม่ส่งมา = ไม่แก้) */
    const phoneCheck = normalizePhone(phone, { label: 'เบอร์โทร' });
    if (phone && !phoneCheck.ok) return res.status(400).json({ message: phoneCheck.message });

    const [result] = await pool.query(`
      UPDATE suppliers
      SET
        supplier_name = COALESCE(?, supplier_name),
        contact_name = COALESCE(?, contact_name),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        lat = ?,
        lng = ?,
        phone = COALESCE(?, phone),
        note = COALESCE(?, note),
        status = COALESCE(?, status),
        image = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE supplier_id = ?
    `, [
      supplier_name,
      contact_name,
      email,
      address,
      lat || null,
      lng || null,
      phone ? phoneCheck.value : null,
      note,
      status,
      image,
      id
    ]);

    if (!result.affectedRows) {
      return res.status(404).json({
        message: "Supplier not found"
      });
    }

    res.json({
      message: "Supplier updated",
      image
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }
});

/* ===============================
DELETE (SOFT DELETE)
=============================== */

router.delete('/:id', async(req,res)=>{

    try{

        const [result] = await pool.query(`
        UPDATE suppliers
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE supplier_id = ?
        `,[req.params.id])

        if(!result.affectedRows){

            return res.status(404).json({
                message:"Supplier not found"
            })

        }

        res.json({
            message:"Supplier deleted"
        })

    }catch(err){

        console.error(err)

        res.status(500).json({
            message:"Server error"
        })

    }

})

module.exports = router