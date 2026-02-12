const router = require("express").Router();
const { requireInternalKey } = require("../../middlewares/requireInternalKey");
const controller = require("./trade.controller");

// Service-to-service execution (Person C executor)
router.post("/execute", requireInternalKey, controller.executeInternal);

router.get("/fills", requireInternalKey, controller.listFillsInternal);
router.get("/fills/by-reference/:referenceId", requireInternalKey, controller.getFillByReferenceInternal);


module.exports = router;
