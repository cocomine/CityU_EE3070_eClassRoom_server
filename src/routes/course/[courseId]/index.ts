import {Request, Router} from "express";
import {getLogger} from "log4js";
import {RedisClient} from "../../../redis_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]");

export interface CourseRequest extends Request {
    params: {
        courseId: string
    };
}

/*======middleware======*/
router.use(async (req: CourseRequest, res, next) => {
    const courseId = req.params.courseId;

    // check courseId format match UUID format
    if (!courseId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(courseId)) {
        return res.status(400).json({code: 400, message: "Invalid course ID format"});
    }

    // get form redis
    const course = await RedisClient.hExists("courses", courseId);
    if (course === 0) {
        return res.status(404).json({code: 404, message: "No course found."});
    }

    next();
});


/*=======router======*/

// path: /course/[courseId]
// GET: Get course info
router.get("/", async (req: CourseRequest, res) => {
    const courseId = req.params.courseId;

    // get form redis
    const course = await RedisClient.hGet("courses", courseId);
    if (!course) {
        return res.status(404).json({code: 404, message: "No course found."});
    }

    res.json({code: 200, message: "Course info retrieved successfully", data: {id: courseId, name: course}});
});

// path: /course/[courseId]/question/*
router.use("/question", require("./question"));
logger.info("Loaded /course/[courseId]/question");

// path: /course/[courseId]/file/*
router.use("/:courseId", require("./file"));
logger.info("Loaded /course/[courseId]/file");

module.exports = router;
