const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const controller = require("./auth.controller");
const { authJwt } = require("../../middlewares/authJwt");

const router = Router();

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/register", authLimiter, controller.register);
router.post("/login", authLimiter, controller.login);

router.get("/me", authJwt, controller.me);

router.post("/refresh", authLimiter, controller.refresh);
router.post("/logout", authLimiter, controller.logout);

module.exports = router;
