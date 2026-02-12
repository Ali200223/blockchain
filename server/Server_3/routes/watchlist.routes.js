const express = require("express");
const router = express.Router();

const authJwt = require("../middleware/authJwt");
const watchlistController = require("../controllers/watchlist.controller");

router.use(authJwt);

router.post("/", watchlistController.addCoin);
router.get("/", watchlistController.getWatchlist);
router.delete("/:symbol", watchlistController.removeCoin);

module.exports = router;
