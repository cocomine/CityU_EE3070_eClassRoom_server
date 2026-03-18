import {Request, Router} from "express";
import {getLogger} from "log4js";
import xss from "xss";
import {RedisClient} from "../../redis_service";
import {DB} from "../../sql_service";

const router = Router();
const logger = getLogger("/course");

export interface PostCourseBody {
    name?: string;
}

/*=======router======*/
// path: /course/[courseId]/*
router.use("/:courseId", require("./[courseId]"));
logger.info("Loaded /course/[courseId]");

// path: /course
// GET: list course
router.get("/", async (req, res) => {
    const courses = await RedisClient.hGetAll("courses");

    if (Object.keys(courses).length === 0) {
        return res.status(404).json({code: 404, message: "No courses found."});
    }

    const courseList = Object.entries(courses).map(([id, name]) => ({id, name}));
    res.json({code: 200, message: "Course list retrieved successfully", data: courseList});
});

// path: /course
// POST: create course
router.post("/", async (req: Request<null, any, PostCourseBody | undefined>, res) => {
    let name = req.body?.name;

    // Check required fields
    if (!name) {
        return res.status(400).json({code: 400, message: "Course name is required"});
    }

    name = xss(name).trim(); // xss clean
    const courseId = crypto.randomUUID(); // Gen UUID

    try {
        // save in redis
        await RedisClient.hSet("courses", courseId, name);

        // save ih DB
        const stmt = await DB.prepare("INSERT INTO courses (id, name) VALUES (?, ?)");
        await stmt.bind(courseId, name);
        await stmt.run();
        await stmt.finalize();
        res.json({code: 200, message: "Course created successfully", data: {courseId}});
    } catch (err) {
        res.status(500).json({code: 500, message: "Course created failed"});
        console.error(err);
    }
});

/*======= router end =========*/

module.exports = router;