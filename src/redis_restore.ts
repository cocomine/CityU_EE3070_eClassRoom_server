import {DB} from "./sql_service";
import {RedisClient} from "./redis_service";
import {QuestionGenerateTaskQueue} from "./utils/QuestionGenerateQueue";

export interface Course {
    ID: string;
    name: string;
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
}

export async function restoreRedis() {
    // restore courses
    await restoreCourses();

    // restore questions
    await restoreQuestions();
}

/**
 * restore courses
 */
async function restoreCourses() {
    const courses = await DB.all<Course[]>("SELECT * FROM courses");
    const redisMulti = RedisClient.multi();
    courses.forEach(course => {
        redisMulti.hSet("courses", course.ID, course.name);
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
            const results = await DB.all<SQLQuestionsList[]>("SELECT question FROM questions_list WHERE question_ID = ? ORDER BY sub_ID", [ID]);
            const resultList = results.map(r => r.question);
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