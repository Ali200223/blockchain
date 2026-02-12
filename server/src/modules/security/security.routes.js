const { Router } = require("express");
const { authJwt } = require("../../middlewares/authJwt");

const featuresController = require("./securityFeatures.controller");
const eventsController = require("./securityEvents.controller");
const sessionRiskController = require("./sessionRisk.controller");


const router = Router();

router.get("/health", (_req, res) => res.json({ ok: true }));

router.get("/me/features", authJwt, featuresController.me);
router.get("/me/events", authJwt, eventsController.meEvents);
router.post("/session/start", authJwt, sessionRiskController.start);
router.post("/session/score", authJwt, sessionRiskController.score);
router.get("/session/current", authJwt, sessionRiskController.current);
router.post("/session/end", authJwt, sessionRiskController.end);


module.exports = router;
