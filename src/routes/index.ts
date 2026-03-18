import {Router} from "express";
import {getLogger} from "log4js";

const router = Router();
const logger = getLogger("/");

/*=======router======*/
// path: /classroom/*
router.use("/classroom", require("./classroom"));
logger.info("Loaded /classroom");

// path: /course/*
router.use("/course", require("./course"));
logger.info("Loaded /course");

// path: /task/*
router.use("/task", require("./task"));
logger.info("Loaded /task");

// path: /
router.get("/", (req, res) => {
    res.status(200).json({code: 200, message: "This is home page! Use '/course' or '/classroom'"});
});

module.exports = router;