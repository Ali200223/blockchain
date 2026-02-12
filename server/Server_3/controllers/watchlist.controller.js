const Watchlist = require("../models/watchlist");


exports.addCoin = async (req, res) => {
  try {
    const { symbol } = req.body;
    //console.log(symbol) 
    if (!symbol) {
      return res.status(400).json({ message: "symbol is required" });
    }
    //symbol = symbol.toUpperCase().trim();
    
    const entry = await Watchlist.create({
      userId: req.auth.userId,
      symbol
    });

    res.status(201).json(entry);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: "Coin already in watchlist"
      });
    }

    res.status(500).json({ message: "Failed to add coin" });
  }
};


exports.getWatchlist = async (req, res) => {
  try {
    const coins = await Watchlist.find(
      { userId: req.auth.userId },
      { _id: 0, symbol: 1 }
    );

    res.json(coins);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch watchlist" });
  }
};


exports.removeCoin = async (req, res) => {
  try {
    const { symbol } = req.params;

    const result = await Watchlist.deleteOne({
      userId: req.auth.userId,
      symbol
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Coin not found in watchlist"
      });
    }

    res.json({ message: "Coin removed from watchlist" });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove coin" });
  }
};

