import {Router} from "express";
import {getLogger} from "log4js";
import {CourseRequest} from "../../index";
import {RedisClient} from "../../../../../redis_service";
import {DB} from "../../../../../sql_service";

const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]");

export interface CourseQuestionRequest extends CourseRequest {
    params: {
        courseId: string;
        questionId: string;
    };
}

export interface PutCourseQuestionRequest extends CourseQuestionRequest {
    body: {
        visibility?: "public" | "private";
    };
}

/*======middleware======*/
router.use(async (req: CourseQuestionRequest, res, next) => {
    const {courseId, questionId} = req.params;

    // check courseId format match UUID format
    if (!questionId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(questionId)) {
        return res.status(400).json({code: 400, message: "Invalid course ID format"});
    }

    // get form redis
    const course = await RedisClient.sIsMember("course:" + courseId + ":question", questionId);
    if (course === 0) {
        return res.status(404).json({code: 404, message: `No question found in course ${courseId}.`});
    }

    next();
});


/*=======router======*/
// path: /course/[courseId]/question/[questionId]
// GET: Returns the final question when DONE & return student mark (200).
//      If task is not finished yet, returns 202 Accepted with current status (meta).
router.get("/", async (req: CourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;
    const resultKey = `course:${courseId}:question:${questionId}:result`;

    // get meta
    const meta = await RedisClient.hGetAll(metaKey);
    if (!meta || !meta.status) {
        return res.status(404).json({
            code: 404,
            message: `Question ${questionId} not found in course ${courseId}.`
        });
    }

    if (meta.status === "DONE") {
        // finish, get result
        const result = await RedisClient.json.get(resultKey);
        return res.status(200).json({
            code: 200,
            message: `Question ${questionId} is DONE.`,
            data: {
                meta,
                question: result,
                mark: null //TODO: student mark
            }
        });
    } else {
        // not finish, show meta
        return res.status(202).json({
            code: 202,
            message: `Question ${questionId} is not ready yet.`,
            data: {
                meta
            }
        });
    }
});

// path: /course/[courseId]/question/[questionId]
// PUT: update question visibility (private/public) return 200
//      If task is not DONE yet, return 409 Conflict with current status (meta).
router.put("/", async (req: PutCourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const {visibility} = req.body;
    const metaKey = `course:${courseId}:question:${questionId}:meta`;

    // verify
    if (!visibility) {
        return res.status(400).json({code: 400, message: "Missing visibility field."});
    }

    // check status
    const status = await RedisClient.hGet(metaKey, "status");
    if (!status) {
        return res.status(404).json({
            code: 404,
            message: `Question ${questionId} not found in course ${courseId}.`
        });
    }
    if (status !== "DONE") {
        return res.status(200).json({
            code: 410,
            message: `Question ${questionId} is ${status}.`,
            data: {
                status
            }
        });
    }

    if (visibility === "public") {
        // make public
        await RedisClient.hSet(metaKey, {visibility});
        res.json({code: 200, message: `Question ${questionId} is Public.`, data: {visibility}});

        try {
            await DB.run("UPDATE questions SET visibility = 1 WHERE ID = ? AND visibility = 0;", [questionId]);
        } catch (error) {
            logger.error(error);
        }
        return;
    } else if (visibility === "private") {
        // make private
        await RedisClient.hSet(metaKey, {visibility});
        res.json({code: 200, message: `Question ${questionId} is Public.`, data: {visibility}});

        try {
            await DB.run("UPDATE questions SET visibility = 0 WHERE ID = ? AND visibility = 1;", [questionId]);
        } catch (error) {
            logger.error(error);
        }
        return;
    } else {
        res.status(400).json({code: 400, message: "Invalid visibility field."});
    }
});

// path: /course/[courseId]/question/[questionId]
// DEL: delete question return 204.
//      If task is not finished yet, return 409 Conflict with current status (meta).
router.delete("/", (req: CourseQuestionRequest, res) => {
    // todo
    console.debug(req.params.courseId, req.params.questionId);
    res.status(200).json({
        code: 200,
        message: "This is course " + req.params.courseId + " question " + req.params.questionId + " delete!"
    });
});

// path: /course/[courseId]/question/[questionId]/cancel/*
router.use("/cancel", require("./cancel"));
logger.info("Loaded /course/[courseId]/question/[questionId]/cancel");

// path: /course/[courseId]/question/[questionId]/stream/*
router.use("/stream", require("./stream"));
logger.info("Loaded /course/[courseId]/question/[questionId]/stream");


module.exports = router;