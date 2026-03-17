import {createClient} from "redis";
import {getLogger} from "log4js";

const logger = getLogger("redis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const RedisClient = createClient({
    url: REDIS_URL,
    database: 0
});

export async function connectRedis() {
    try {
        await RedisClient.connect();
        await RedisClient.flushDb();
        logger.info(`Connected to redis service`);
    } catch (err) {
        logger.error("Failed to connect to Redis:", err);
        throw err;
    }
}

export async function disconnectRedis() {
    try {
        await RedisClient.quit();
        logger.info(`Disconnected to redis service`);
    } catch (err) {
        logger.error("Failed to connect to Redis:", err);
        throw err;
    }
}

RedisClient.on("error", (err) => logger.error("Redis Client Error", err));
RedisClient.on("connect", () => logger.info("Connected to Redis"));