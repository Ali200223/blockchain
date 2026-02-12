const express = require("express");
const authJwt = require("../middleware/authJwt");
const { postbacktest, getbacktests } = require("../controllers/backtest.controller");
const router = express.Router();
router.use(authJwt);


router.post("/", postbacktest);
router.get("/", getbacktests);

module.exports = router;