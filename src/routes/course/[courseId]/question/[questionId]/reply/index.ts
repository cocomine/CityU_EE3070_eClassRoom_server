import {Router} from "express";
import {getLogger} from "log4js";
import {CourseQuestionRequest} from "../index";
import {RedisClient} from "../../../../../../redis_service";
import xss from "xss";
import {SET_IDEM_LUA_SCRIPT} from "../../../../../../utils/LuaScript";
import {DB} from "../../../../../../sql_service";

export interface PostCourseQuestionReplyRequest extends CourseQuestionRequest {
    body: {
        subQuestionId?: number | any;
        content?: string | any;
        clientTaskId?: string | any;
    };
}


const router = Router({mergeParams: true});
const logger = getLogger("/course/[courseId]/question/[questionId]/reply");

/*======middleware======*/
//
router.use(async (req, res, next) => {
    const eid = req.header("X-EID");

    if (!eid || !/^[0-9a-zA-Z]+$/.test(eid)) {
        return res.status(400).json({code: 400, message: "Invalid EID format"});
    }

    next();
});

/*=======router======*/
// path: /course/[courseId]/question/[questionId]/reply
// POST: student reply question
router.post("/", async (req: PostCourseQuestionReplyRequest, res) => {
    const eid = req.header("X-EID");
    const {courseId, questionId} = req.params;
    const subQuestionId = req.body.subQuestionId;
    const content = xss(req.body?.content || "").trim();
    const clientTaskId = req.body.clientTaskId;
    const resultKey = `course:${courseId}:question:${questionId}:result`;
    const replyKey = `course:${courseId}:question:${questionId}:reply`;

    // validate input
    if (!subQuestionId || content === "") {
        return res.status(400).json({code: 400, message: "Missing required fields"});
    }
    if (typeof subQuestionId !== "number") {
        return res.status(400).json({code: 400, message: "Invalid subQuestionId fields"});
    }

    // check sub question is exits
    const subQuestion = await RedisClient.json.get(resultKey, {path: `$[${subQuestionId}]`}) as string[];
    if (subQuestion.length <= 0) {
        return res.status(404).json({code: 404, message: "Sub question not found"});
    }

    // Check clientTaskId
    if (!clientTaskId) {
        return res.status(400).json({code: 400, message: "Client task id is required"});
    }

    // check clientTaskId format match UUID format
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(clientTaskId)) {
        return res.status(400).json({code: 400, message: "clientTaskId must use UUID format"});
    }

    const replyId = crypto.randomUUID();
    const metaKey = `course:${courseId}:question:${questionId}:reply:${replyId}:meta`;

    // Idempotency
    const idemKey = `idem:reply:${clientTaskId}`;
    const idem = await RedisClient.eval(SET_IDEM_LUA_SCRIPT, {
        keys: [idemKey],
        arguments: [replyId]
    });
    if (idem) {
        // already have task
        return res.status(202).json({
            code: 202,
            message: "Request already receive", data: {
                questionId: idem
            }
        });
    }

    // save in database and redis
    try {
        await DB.exec("BEGIN");
        // save database
        const stmt = await DB.prepare(
            `INSERT INTO reply (ID, questionID, subQuestionID, content)
             VALUES (?, ?, ?, ?)`);
        await stmt.bind(replyId, questionId, subQuestionId, content);
        await stmt.run();

        // save meta
        await RedisClient.multi()
            .hSet(metaKey, {
                courseId,
                questionId,
                subQuestionId,
                replyId,
                content,
                status: "PENDING",
                score: 0, // 0-10 score
                createAt: new Date().toISOString(),
                startAt: "",
                finishedAt: "",
                errorMessage: "",
                updateAt: new Date().toISOString()
            })
            .sAdd(replyKey, replyId)
            .exec();
        await DB.exec("COMMIT");
    } catch (err) {
        await DB.exec("ROLLBACK");
        logger.error(err);
        return res.status(500).json({code: 500, message: "Failed to create question."});
    }

    res.status(200).json({code: 200, message: "Reply question successfully."});

    //todo: trigger auto grading task
});

// path: /course/[courseId]/question/[questionId]/reply
// GET: student get all repled of the question
router.get("/", async (req, res) => {

});

module.exports = router;