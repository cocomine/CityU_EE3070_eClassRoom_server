import {DB} from "./sql_service";
import {RedisClient} from "./redis_service";

export interface Course {
    ID: string;
    name: string;
}

export async function restoreRedis() {
    // restore courses
    const courses = await DB.all<Course[]>("SELECT * FROM courses");
    const redisMulti = RedisClient.multi()
    courses.forEach(course => {
        redisMulti.hSet("courses", course.ID, course.name);
    })
    await redisMulti.exec()

    //Todo: restore questions
}