const express = require("express");
const router = express.Router();
const News = require("../models/news");

// GET latest news for frontend
router.get("/", async (req, res) => {
  try {
    const news = await News.find(
      {},
      {
        title: 1,
        source: 1,
        url: 1,
        published_at: 1,
        content: 1,
        _id: 0
      }
    )
      .sort({ published_at: -1 })

    res.json(news);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch news" });
  }
});
router.get("/latest", async (req, res) => {
  try {
    const news = await News.find(
      {},
      {
        title: 1,
        source: 1,
        url: 1,
        published_at: 1,
        content: 1,
        _id: 0
      }
    )
      .sort({ published_at: -1 })
      .limit(1);

    res.json(news);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch latest news" });
  }
});

module.exports = router;
