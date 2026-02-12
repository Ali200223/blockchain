const express = require("express");
const router = express.Router();

const authJwt = require("../middleware/authJwt");
const {postorder,getorders,updateorder,deleteorder} = require("../controllers/order.controller");


router.use(authJwt);


router.post("/", postorder);

router.get("/", getorders);


router.put("/:id", updateorder);

router.delete("/:id", deleteorder);

module.exports = router;
