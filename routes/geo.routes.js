const express = require('express');
const router = express.Router();

const COORD_PATTERNS = [
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,      // pin location on /place/ links
  /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,     // ?q=lat,lng
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,          // @lat,lng,zoom
  /ll=(-?\d+\.\d+),(-?\d+\.\d+)/,        // ll=lat,lng
];

function extractCoords(url) {
  for (const pattern of COORD_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

/* ===============================
RESOLVE A (POSSIBLY SHORTENED) GOOGLE MAPS LINK TO {lat, lng}
=============================== */

router.post('/resolve-map-link', async (req, res) => {
  try {

    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: "url is required" });
    }

    let resolvedUrl = url;

    try {
      const response = await fetch(url, { redirect: 'follow' });
      resolvedUrl = response.url || url;
    } catch (err) {
      console.error("Failed to follow redirect for map link:", err.message);
    }

    const coords = extractCoords(resolvedUrl) || extractCoords(url);

    if (!coords) {
      return res.status(422).json({ message: "ไม่พบพิกัดจากลิงก์นี้" });
    }

    res.json(coords);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }
});

module.exports = router;
