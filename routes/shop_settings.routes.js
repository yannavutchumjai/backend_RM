const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/* ===============================
GET SHOP LOCATION SETTINGS
=============================== */

router.get('/', async (req, res) => {
  try {

    const [rows] = await pool.query(
      "SELECT shop_name, lat, lng, updated_at FROM shop_settings WHERE id = 1"
    );

    res.json(rows[0] || { shop_name: null, lat: null, lng: null });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }
});


/* ===============================
UPDATE SHOP LOCATION SETTINGS
=============================== */

router.put('/', async (req, res) => {
  try {

    const { shop_name, lat, lng } = req.body;

    await pool.query(`
      UPDATE shop_settings
      SET
        shop_name = COALESCE(?, shop_name),
        lat = ?,
        lng = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [
      shop_name,
      lat || null,
      lng || null
    ]);

    res.json({
      message: "Shop settings updated"
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }
});

module.exports = router;
