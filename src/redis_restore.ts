import {DB} from "./sql_service";
import {RedisClient} from "./redis_service";
import {QuestionGenerateTaskQueue} from "./utils/QuestionGenerateQueue";
import {getLogger} from "log4js";
import {MarkingTaskQueue} from "./utils/ReplyMarkQueue";

export interface Course {
    ID: string;
    name: string;
    digit_id: string;
}

export interface SQLQuestions {
    ID: string;
    courseID: string;
    prompt: string;
    status: number;
    title: string;
    visibility: number;
}

export interface SQLQuestionsList {
    question: string;
    key_points: string;
    expected_answer: string;
}

export interface SQLFiles {
    ID: string;
    courseID: string;
    filename: string;
    sha256: string;
}

export interface SQLFileBlob {
    sha256: string;
    mime: string;
    blob: Buffer;
    size: number;
}

export interface SQLReply {
    ID: string;
    questionID: string;
    subQuestionID: number;
    score: number | null;
    status: number;
    content: string;
    EID: string;
    summary: string | null;
    next_step: string | null;
    understanding_level: "none" | "low" | "partial" | "good" | "excellent";
    courseID: string;
    create_datetime: string;
}

export interface SQLReplyKeyPoint {
    reply_ID: string;
    point: string;
    status: "full" | "partial" | "missing";
    comment: string;
    point_ID: number;
}


export async function restoreRedis() {
    await restoreCourses();
    await restoreQuestions();
    await restoreFiles();
    await restoreReply();
    getLogger("RedisRestore").info("Redis restore completed.");
}

/**
 * restore courses
 */
async function restoreCourses() {
    const courses = await DB.all<Course[]>("SELECT * FROM courses");
    const redisMulti = RedisClient.multi();
    courses.forEach(course => {
        redisMulti.sAdd("courses", course.ID);
        redisMulti.hSet(`courses:${course.ID}:meta`, {
            courseId: course.ID,
            name: course.name,
            digitId: course.digit_id
        });
    });
    await redisMulti.exec();
}

/**
 * restore questions
 */
async function restoreQuestions() {
    const questions = await DB.all<SQLQuestions[]>("SELECT * FROM questions");
    for (let question of questions) {
        const {ID, courseID, prompt, status, title, visibility} = question;
        const metaKey = `course:${courseID}:question:${ID}:meta`;
        const questionKey = `course:${courseID}:question`;
        const resultKey = `course:${courseID}:question:${ID}:result`;
        const redisMulti = RedisClient.multi();

        // set meta
        redisMulti.hSet(metaKey, {
            questionId: ID,
            title,
            visibility,
            courseId: courseID,
            prompt,
            status: ["PENDING", "DONE", "ERROR", "CANCELLED"].at(status) ?? "ERROR", // 0 = PENDING, 1 = DONE, 2 = ERROR, 3 = CANCELLED
            createAt: new Date().toISOString(),
            finishedAt: status === 1 ? new Date().toISOString() : "",
            errorMessage: "",
            updateAt: new Date().toISOString(),
            startAt: status === 1 ? new Date().toISOString() : "",
        });
        redisMulti.sAdd(questionKey, ID);

        // set result if DONE
        if (status === 1) {
            const results = await DB.all<SQLQuestionsList[]>("SELECT * FROM questions_list WHERE question_ID = ? ORDER BY sub_ID", [ID]);
            const resultList = results.map(r => ({
                question: r.question,
                keypoint: JSON.parse(r.key_points),
                expectedAnswer: r.expected_answer
            }));
            redisMulti.json.set(resultKey, "$", resultList);
        }
        await redisMulti.exec();

        // add queue if still in PENDING
        if (status === 0) {
            await QuestionGenerateTaskQueue.add("QuestionGenerateTask", {questionId: ID, courseId: courseID, prompt}, {
                jobId: ID,
                removeOnComplete: true,
                removeOnFail: true,
                attempts: 5,
                delay: 5000,
                backoff: {
                    type: "exponential",
                    delay: 1000,
                }
            });
        }
    }
}

async function restoreFiles() {
    const files = await DB.all<SQLFiles[]>("SELECT * FROM files");
    for (let file of files) {
        const {ID, courseID, sha256, filename} = file;
        const filesKey = `course:${courseID}:file`;
        const metaKey = `course:${courseID}:file:${ID}:meta`;
        const results =
            await DB.get<Pick<SQLFileBlob, "mime" | "size">>("SELECT mime, size FROM file_blob WHERE sha256 = ?", [sha256]);

        if (!results) continue; // if not found, skip

        // save redis
        await RedisClient.multi()
            .hSet(metaKey, {
                fileId: ID,
                courseId: courseID,
                mime: results.mime,
                filename,
                sha256,
                size: results.size
            })
            .sAdd(filesKey, ID)
            .exec();
    }
}

async function restoreReply() {
    const replies = await DB.all<SQLReply[]>("SELECT reply.*, questions.courseID FROM reply, questions WHERE reply.questionID = questions.ID ORDER BY reply.subQuestionID");
    for (let reply of replies) {
        const {
            ID,
            questionID,
            subQuestionID,
            score,
            status,
            content,
            EID,
            understanding_level,
            next_step,
            summary,
            courseID,
            create_datetime
        } = reply;
        const metaKey = `course:${courseID}:question:${questionID}:reply:${ID}:meta`;
        const replyKey = `course:${courseID}:question:${questionID}:reply`;
        const resultKey = `course:${courseID}:question:${questionID}:reply:${ID}:result`;
        const studentKey = `course:${courseID}:student:${EID}:reply`;
        const redisMulti = RedisClient.multi();

        // set meta
        redisMulti.hSet(metaKey, {
            courseId: courseID,
            questionId: questionID,
            subQuestionId: subQuestionID,
            replyId: ID,
            content,
            eid: EID,
            status: ["PENDING", "DONE", "ERROR", "CANCELLED"].at(status) ?? "ERROR", // 0 = PENDING, 1 = DONE, 2 = ERROR, 3 = CANCELLED,
            score: score ?? "", // 0-100 score
            createAt: new Date(create_datetime + "Z").toISOString(),
            startAt: status === 1 ? new Date().toISOString() : "",
            finishedAt: status === 1 ? new Date().toISOString() : "",
            errorMessage: "",
            updateAt: new Date().toISOString()
        });
        redisMulti.sAdd(replyKey, ID);
        redisMulti.sAdd(studentKey, questionID);

        // set result if DONE
        if (status === 1) {
            const keyPoints = await DB.all<SQLReplyKeyPoint[]>("SELECT * FROM reply_keypoint WHERE reply_ID = ? ORDER BY point_ID", [ID]);
            const keyPointList = keyPoints.map(r => ({
                point: r.point,
                status: r.status,
                comment: r.comment,
            }));
            redisMulti.json.set(resultKey, "$", {
                score: score,
                understanding_level: understanding_level,
                key_point_feedback: keyPointList,
                one_sentence_summary: summary,
                next_step: next_step,
            });
        }
        await redisMulti.exec();

        // add queue if still in PENDING
        if (status === 0) {
            await MarkingTaskQueue.add("MarkingTaskQueue", {
                questionId: questionID,
                courseId: courseID,
                subQuestionId: subQuestionID,
                reply: content,
                replyId: ID
            }, {
                jobId: ID,
                removeOnComplete: true,
                removeOnFail: true,
                attempts: 5,
                backoff: {
                    type: "exponential",
                    delay: 1000,
                }
            });
        }
    }
}