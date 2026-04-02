import {Router} from "express";
import {getLogger} from "log4js";
import {CourseQuestionRequest} from "../index";
import {RedisClient} from "../../../../../../redis_service";
import xss from "xss";
import {DB} from "../../../../../../sql_service";
import {MarkingTaskQueue} from "../../../../../../utils/ReplyMarkQueue";
import {SET_IDEM_LUA_SCRIPT} from "../../../../../../utils/LuaScript";

export interface PostCourseQuestionReplyRequest extends CourseQuestionRequest {
    body: {
        subQuestionId?: number | any;
        content?: string | any;
        clientTaskId?: string | any;
        overwrite?: boolean | any;
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
// GET: get all repled of the question
router.get("/", async (req: CourseQuestionRequest, res) => {
    const {courseId, questionId} = req.params;
    const replyKey = `course:${courseId}:question:${questionId}:reply`;
    const metaList = [];

    //todo
    //const metaKey = `course:${courseId}:question:${questionId}:reply:${targetReplyId}:meta`;
});

// path: /course/[courseId]/question/[questionId]/reply
// POST: student reply question
router.post("/", async (req: PostCourseQuestionReplyRequest, res) => {
    const eid = req.header("X-EID") as string;
    const {courseId, questionId} = req.params;
    const {subQuestionId, clientTaskId, overwrite} = req.body;
    const content = xss(req.body?.content || "").trim();
    const resultKey = `course:${courseId}:question:${questionId}:result`;
    const questionMetaKey = `course:${courseId}:question:${questionId}:meta`;
    const replyKey = `course:${courseId}:question:${questionId}:reply`;
    const studentKey = `student:${eid}:reply`;

    // validate input
    if (!subQuestionId || content === "") {
        return res.status(400).json({code: 400, message: "Missing required fields"});
    }
    if (typeof subQuestionId !== "number") {
        return res.status(400).json({code: 400, message: "Invalid subQuestionId fields"});
    }
    if (overwrite !== undefined && typeof overwrite !== "boolean") {
        return res.status(400).json({code: 400, message: "Invalid overwrite fields"});
    }

    // Check clientTaskId
    if (!clientTaskId) {
        return res.status(400).json({code: 400, message: "Client task id is required"});
    }

    // check clientTaskId format match UUID format
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(clientTaskId)) {
        return res.status(400).json({code: 400, message: "clientTaskId must use UUID format"});
    }

    // check sub question is exist
    const subQuestion = await RedisClient.json.get(resultKey, {path: `$[${subQuestionId}]`}) as string[];
    if (subQuestion.length <= 0) {
        return res.status(404).json({code: 404, message: "Sub question not found"});
    }

    // check is public
    const visibility = await RedisClient.hGet(questionMetaKey, "visibility");
    if (visibility === null || visibility === "0") {
        return res.status(403).json({code: 403, message: "Question is not public, you can't reply."});
    }

    // check Conflict
    if (!overwrite) {
        const exist = await RedisClient.sIsMember(studentKey, questionId);
        if (exist) {
            return res.status(409).json({
                code: 409,
                message: "Conflict: You have already replied to this question. Please set overwrite to true if you want to overwrite the reply."
            });
        }
    }

    // Key
    let targetReplyId = crypto.randomUUID();
    const metaKey = `course:${courseId}:question:${questionId}:reply:${targetReplyId}:meta`;

    // Idempotency
    const idemKey = `idem:reply:${clientTaskId}`;
    const idem = await RedisClient.eval(SET_IDEM_LUA_SCRIPT, {
        keys: [idemKey],
        arguments: [targetReplyId]
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

        // check for existing record and handle overwrite
        if (overwrite) {
            const existingReply = await DB.get("SELECT ID FROM reply WHERE questionID = ? AND subQuestionID = ? AND EID = ?", [questionId, subQuestionId, eid]);
            if (existingReply) {
                // cancel old job if exist
                const job = await MarkingTaskQueue.getJob(existingReply.ID);
                if (job) {
                    // set cancel flag in redis, the marking worker will check this flag before marking, if exist then skip marking and delete the job.
                    const cancelKey = `course:${courseId}:question:${questionId}:reply:${existingReply.ID}:cancel`;
                    await RedisClient.set(cancelKey, 1, {EX: 3600});
                    job.remove().catch(() => {
                    });
                } else {
                    // if not exist, remove from redis
                    await RedisClient.multi()
                        .del(`course:${courseId}:question:${questionId}:reply:${existingReply.ID}:meta`)
                        .del(`course:${courseId}:question:${questionId}:reply:${existingReply.ID}:result`)
                        .sRem(replyKey, existingReply.ID)
                        .exec();
                }

                //delete old reply
                await DB.run("DELETE FROM reply WHERE ID = ?", existingReply.ID);
            }
        }

        // insert new
        const stmt = await DB.prepare(
            `INSERT INTO reply (ID, questionID, subQuestionID, EID, content)
             VALUES (?, ?, ?, ?, ?)`);
        await stmt.bind(targetReplyId, questionId, subQuestionId, eid, content);
        await stmt.run();

        // save meta
        await RedisClient.multi()
            .hSet(metaKey, {
                courseId,
                questionId,
                subQuestionId,
                replyId: targetReplyId,
                content,
                eid,
                status: "PENDING",
                score: 0, // 0-100 score
                createAt: new Date().toISOString(),
                startAt: "",
                finishedAt: "",
                errorMessage: "",
                updateAt: new Date().toISOString()
            })
            .sAdd(replyKey, targetReplyId) // this question's all reply
            .sAdd(studentKey, questionId) // this student all repled question
            .exec();
        await DB.exec("COMMIT");
    } catch (err: any) {
        await DB.exec("ROLLBACK");

        // backup duplicate check
        if (err.code === "SQLITE_CONSTRAINT" || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err.code === "SQLITE_CONSTRAINT_UNIQUE") {
            logger.warn(`SQL Conflict: ${err.message}`);
            return res.status(409).json({code: 409, message: "Conflict: This reply or related record already exists."});
        }

        logger.error("SQL Error:", err);
        return res.status(500).json({code: 500, message: "Failed to create reply."});
    }

    res.status(200).json({
        code: 200, message: "Reply question successfully.", data: {
            replyId: targetReplyId, status: "PENDING"
        }
    });

    // Enqueue Job
    await MarkingTaskQueue.add("MarkingTaskQueue", {
        questionId,
        courseId,
        subQuestionId,
        reply: content,
        replyId: targetReplyId
    }, {
        jobId: targetReplyId,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 5,
        backoff: {
            type: "exponential",
            delay: 1000,
        }
    });
});


module.exports = router;