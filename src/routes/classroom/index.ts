import {Router} from "express";
import {getLogger} from "log4js";
import {RedisClient} from "../../redis_service";
import {RedisJSON} from "redis";

interface ClassroomEnvironment {
    brightness: number;
    temperature_c: number;
    water: number;
    co2: number;
}

interface ClassroomLearningState {
    attention?: number;
    stress?: number;
}

interface ClassroomPostBody {
    device: string;
    timestamp: number;
    seq?: number;
    environment_valid: boolean;
    crc_ok?: boolean;
    environment: ClassroomEnvironment;
    learning_state: ClassroomLearningState[];
}


const router = Router();
const logger = getLogger("/classroom");
const CLASSROOM_CACHE_KEY = "classroom";


/*=======router======*/
// path: /classroom
// GET: show classroom environment data
router.get("/", async (req, res) => {
    try {
        // If cache does not exist, return 204 with empty body.
        if (await RedisClient.exists(CLASSROOM_CACHE_KEY) === 0) {
            return res.status(204).send();
        }

        // Cache exists, return cached classroom payload.
        const cachedData = await RedisClient.json.get(CLASSROOM_CACHE_KEY);
        return res.status(200).json({code: 200, message: "Successfully get data", data: cachedData});
    } catch (err) {
        logger.error(err);
        return res.status(500).json({code: 500, message: "Failed to get classroom data"});
    }
});

// path: /classroom
// POST: update classroom environment data
router.post("/", async (req, res) => {
    // Validate field types first. If any type is wrong, return 400.
    if (!isClassroomPostBody(req.body)) {
        return res.status(400).json({code: 400, message: "Invalid request body type"});
    }

    // Device marks this frame as invalid -> ignore and return 204.
    if (!req.body.environment_valid) {
        return res.status(204).send();
    }

    // Build a RedisJSON-compatible object explicitly to satisfy strict TS typing.
    // Keep empty learning_state objects as {} in Redis.
    const normalizedLearningState = req.body.learning_state.map((state) => {
        const item: Record<string, number> = {};
        if (state.attention !== undefined) item.attention = state.attention;
        if (state.stress !== undefined) item.stress = state.stress;
        return item;
    });

    const payload: RedisJSON = {
        timestamp: req.body.timestamp,
        environment: {
            brightness: req.body.environment.brightness,
            temperature_c: req.body.environment.temperature_c,
            water: req.body.environment.water,
            co2: req.body.environment.co2
        },
        learning_state: normalizedLearningState
    };

    // save redis
    try {
        await RedisClient.json.set(CLASSROOM_CACHE_KEY, "$", payload);
        return res.status(200).json({code: 200, message: "Classroom data updated"});
    } catch (err) {
        logger.error(err);
        return res.status(500).json({code: 500, message: "Failed to update classroom data"});
    }
});


/**
 * Checks if a value is a finite number.
 *
 * @param {unknown} value - The value to check.
 * @returns {value is number} True if the value is a finite number, false otherwise.
 */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * Checks if a value is an object record (not null and not an array).
 *
 * @param {unknown} value - The value to check.
 * @returns {value is Record<string, unknown>} True if the value is a plain object, false otherwise.
 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates if the given value conforms to the ClassroomEnvironment interface.
 *
 * @param {unknown} value - The value to validate.
 * @returns {value is ClassroomEnvironment} True if it is a valid ClassroomEnvironment, false otherwise.
 */
function isClassroomEnvironment(value: unknown): value is ClassroomEnvironment {
    if (!isObjectRecord(value)) return false;

    return isFiniteNumber(value.brightness)
        && isFiniteNumber(value.temperature_c)
        && isFiniteNumber(value.water)
        && isFiniteNumber(value.co2);
}

/**
 * Validates if the given value conforms to the ClassroomLearningState interface.
 *
 * @param {unknown} value - The value to validate.
 * @returns {value is ClassroomLearningState} True if it is a valid ClassroomLearningState, false otherwise.
 */
function isClassroomLearningState(value: unknown): value is ClassroomLearningState {
    if (!isObjectRecord(value)) return false;

    // Allow {}. If fields exist, they must be finite numbers.
    return (value.attention === undefined || isFiniteNumber(value.attention))
        && (value.stress === undefined || isFiniteNumber(value.stress));
}

/**
 * Validates if the given value conforms to the expected ClassroomPostBody structure.
 *
 * @param {unknown} value - The value to validate.
 * @returns {value is ClassroomPostBody} True if the structure is correct, false otherwise.
 */
function isClassroomPostBody(value: unknown): value is ClassroomPostBody {
    if (!isObjectRecord(value)) return false;

    return typeof value.device === "string"
        && isFiniteNumber(value.timestamp)
        && (value.seq === undefined || Number.isInteger(value.seq))
        && typeof value.environment_valid === "boolean"
        && (value.crc_ok === undefined || typeof value.crc_ok === "boolean")
        && isClassroomEnvironment(value.environment)
        && Array.isArray(value.learning_state)
        && value.learning_state.every(isClassroomLearningState);
}


module.exports = router;
