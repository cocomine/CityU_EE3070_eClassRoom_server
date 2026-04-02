import {DB} from "./sql_service";
import {RedisClient} from "./redis_service";
import {QuestionGenerateTaskQueue} from "./utils/QuestionGenerateQueue";
import {getLogger} from "log4js";

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
    //todo
}