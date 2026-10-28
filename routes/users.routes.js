const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { normalizePhone } = require('../lib/phone');
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

/* ตาราง users มีรหัสผ่าน 2 แบบปนกัน (มาจากโค้ดคนละเวอร์ชัน)
   แถวที่เป็น bcrypt จะขึ้นต้นด้วย $2a$ / $2b$ / $2y$ */
const isHashed = (value) => /^\$2[aby]\$/.test(String(value || ""));

/* ===================================================
   📁 UPLOAD DIRECTORY SETUP (ใช้โฟลเดอร์เดียวกับ products)
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

/* =========================
   GET /users (ดึงทั้งหมด)
========================= */
router.get("/", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users");
    res.json(rows);
  } catch (e) {
    console.error("GET /users error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

/* =========================
   POST /users (register)
========================= */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { name, nickname, email, password, phone, address, role } = req.body || {};
    /* หน้าสมัครสมาชิกไม่มีช่อง username → ใช้อีเมลแทน (อีเมลเป็น unique อยู่แล้ว) */
    const username = req.body?.username || email;

    /* เบอร์โทรต้องเป็นตัวเลข 10 หลัก */
    const phoneCheck = normalizePhone(phone, { label: 'เบอร์โทร' });
    if (!phoneCheck.ok) return res.status(400).json({ message: phoneCheck.message });

    // field จำเป็นจริง ๆ
    if (!name || !username || !email || !password) {
      return res.status(400).json({
        message: "name, username, email, password are required",
      });
    }

    // role: ถ้าไม่ส่งมา ให้เป็น admin (หรือ staff ตามระบบคุณ)
    const userRole = role && ["admin", "staff"].includes(role)
      ? role
      : "admin";

    const image = req.file ? req.file.filename : null;

    const [result] = await pool.query(
      `INSERT INTO users
        (name, nickname, username, email, password, role, phone, address, image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        name,
        nickname || null,
        username,
        email,
        password,        // ⚠️ ถ้าจะดี ควร hash ด้วย bcrypt
        userRole,
        phoneCheck.value,
        address || null,
        image,
      ]
    );

    res.status(201).json({
      id: result.insertId,
      name,
      nickname: nickname || null,
      username,
      email,
      role: userRole,
      phone: phoneCheck.value,
      address: address || null,
      image,
    });
  } catch (e) {
    console.error("POST /users error:", e);
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "username หรือ email นี้ถูกใช้แล้ว" });
    }
    res.status(500).json({ message: e.message || "Server error" });
  }
});

/* =========================
   POST /users/login
========================= */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        message: "email & password are required",
      });
    }

    /* ดึงตามอีเมลก่อน แล้วค่อยเทียบรหัสในโค้ด
       (เทียบใน SQL ตรง ๆ ไม่ได้ เพราะแถวที่เป็น bcrypt จะไม่มีวันตรง) */
    /* บางแถวมี \r\n หรือช่องว่างติดมากับอีเมล (ข้อมูลนำเข้าไม่สะอาด)
       เทียบแบบตัดอักขระพวกนี้ออกก่อน ไม่งั้นบัญชีนั้นล็อกอินไม่ได้เลย */
    const [rows] = await pool.query(
      `SELECT id, name, email, role, phone, address, image, password
       FROM users
       WHERE REPLACE(REPLACE(TRIM(email), '\\r', ''), '\\n', '') = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [String(email).trim()]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];
    const stored = user.password || "";

    const ok = isHashed(stored)
      ? await bcrypt.compare(password, stored)
      : password === stored;

    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    /* ล็อกอินผ่านแล้วแต่ยังเก็บเป็นข้อความธรรมดา → อัปเกรดเป็น bcrypt ให้เลย
       ผู้ใช้ยังใช้รหัสเดิมได้ ไม่ต้องตั้งใหม่ (ถ้าอัปเดตพลาดก็ไม่ขวางการล็อกอิน) */
    if (!isHashed(stored)) {
      try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query("UPDATE users SET password = ? WHERE id = ?", [hashed, user.id]);
      } catch (e) {
        console.error("อัปเกรดรหัสผ่านเป็น bcrypt ไม่สำเร็จ (id " + user.id + "):", e.message);
      }
    }

    /* ห้ามส่งคอลัมน์ password กลับไปให้ client */
    delete user.password;
    res.json(user);
  } catch (e) {
    console.error("POST /users/login error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

/* =========================
   PUT /users/:id
========================= */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nickname, username, email, password, phone, address, role, removeImage } = req.body || {};

    const phoneCheck = normalizePhone(phone, { label: 'เบอร์โทร' });
    if (phone && !phoneCheck.ok) return res.status(400).json({ message: phoneCheck.message });

    const [existingRows] = await pool.query(
      "SELECT id, image FROM users WHERE id = ? LIMIT 1",
      [id]
    );

    if (!existingRows.length) {
      return res.status(404).json({ message: "User not found" });
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

    await pool.query(
      `UPDATE users
       SET name = COALESCE(?, name),
           nickname = COALESCE(?, nickname),
           username = COALESCE(?, username),
           email = COALESCE(?, email),
           password = COALESCE(?, password),
           role = COALESCE(?, role),
           phone = COALESCE(?, phone),
           address = COALESCE(?, address),
           image = ?
       WHERE id = ?`,
      [
        name ?? null,
        nickname ?? null,
        username ?? null,
        email ?? null,
        password ?? null,
        role ?? null,
        phone ? phoneCheck.value : null,
        address ?? null,
        image,
        id,
      ]
    );

    const [rows] = await pool.query(
      `SELECT id, name, nickname, username, email, role, phone, address, image, created_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    res.json(rows[0]);
  } catch (e) {
    console.error("PUT /users/:id error:", e);
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "username หรือ email นี้ถูกใช้แล้ว" });
    }
    res.status(500).json({ message: e.message || "Server error" });
  }
});

/* =========================
   DELETE /users/:id
========================= */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [existingRows] = await pool.query(
      "SELECT image FROM users WHERE id = ? LIMIT 1",
      [id]
    );

    const [result] = await pool.query(
      "DELETE FROM users WHERE id = ?",
      [id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: "User not found" });
    }

    if (existingRows[0]?.image) {
      const imagePath = path.join(uploadDir, existingRows[0].image);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    res.json({ message: "Deleted successfully" });
  } catch (e) {
    console.error("DELETE /users/:id error:", e);
    res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;
