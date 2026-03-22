import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../index";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/file");

/*=======router======*/
// path: /course/[courseId]/file/
// GET: list all uploaded files
router.get("/", async (req: CourseRequest, res) => {
    //todo
});

// path: /course/[courseId]/file/
// POST: upload file
router.post("/", async (req: CourseRequest, res) => {
    //todo: upload file
});

// path: /course/[courseId]/file/[fileId]/*
router.use("/:fileId", require("./[fileId]"));
logger.info("Loaded /course/[courseId]/file/[fileId]");

module.exports = router;