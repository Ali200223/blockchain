const express = require("express");
const router = express.Router();

const authJwt = require("../middleware/authJwt");
const portfolioController = require("../controllers/portfolio.controller");

router.use(authJwt);

router.get("/", portfolioController.getPortfolio);

module.exports = router;
