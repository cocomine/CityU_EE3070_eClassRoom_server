import {Request, Router} from "express";
import {getLogger} from "log4js";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/task");

/*=======router======*/
// path: /course/[courseId]/task/[taskId]/*
router.use("/:taskId", require("./[taskId]"));
logger.info("Loaded /course/[courseId]/task/[taskId]");

// path: /course/[courseId]/task
// GET: list all running task mate (status)
router.get("/", (req: Request<{ courseId: string }>, res) => {
    console.debug(req.params.courseId);
    res.status(200).json({code: 200, message: `This is course ${req.params.courseId} task!`});
    // todo
});

module.exports = router;