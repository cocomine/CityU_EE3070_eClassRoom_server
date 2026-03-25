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
// path: /course
// GET: list course
router.get("/", async (req, res) => {
    const courses = await RedisClient.sMembers("courses");
    if (courses.length === 0) {
        return res.status(404).json({code: 404, message: "No courses found."});
    }

    const metaList = [];
    for (let courseId of courses) {
        console.log();
        metaList.push({id: courseId, ...await RedisClient.hGetAll(`courses:${courseId}:meta`)});
    }
    res.json({code: 200, message: "Course list retrieved successfully", data: metaList});
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
    let digitId = Math.floor(Math.random() * 999999) + 1;
    const digitIdStr = digitId.toString().padStart(6, "0");

    try {
        await DB.exec("BEGIN");
        // save ih DB
        const stmt = await DB.prepare("INSERT INTO courses (id, name, digit_id) VALUES (?, ?, ?)");
        await stmt.bind(courseId, name, digitIdStr);
        await stmt.run();
        await stmt.finalize();

        // save in redis
        await RedisClient.sAdd("courses", courseId);
        await RedisClient.hSet(`courses:${courseId}:meta`, {courseId, name, digitId: digitIdStr});
        await DB.exec("COMMIT");
    } catch (err) {
        logger.error(err);
        await DB.exec("ROLLBACK");
        return res.status(500).json({code: 500, message: "Course created failed"});
    }

    res.json({code: 200, message: "Course created successfully", data: {courseId, digitId: digitIdStr}});
});

// path: /course/[courseId]/*
router.use("/:courseId", require("./[courseId]"));
logger.info("Loaded /course/[courseId]");
/*======= router end =========*/

module.exports = router;