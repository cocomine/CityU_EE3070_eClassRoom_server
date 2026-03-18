import "dotenv/config";
import express, {Application} from "express";
import log4js from "log4js";
import figlet from "figlet";
import {connectRedis, disconnectRedis} from "./redis_service";
import * as http from "node:http";
import {closeDB, openDB} from "./sql_service";
import {restoreRedis} from "./redis_restore";
import {shutdownQuestionGenerateTaskQueue} from "./utils/QuestionGenerateQueue";

const app: Application = express();
const logger = log4js.getLogger("server");
const PORT = parseInt(process.env.PORT || "3001");
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV ?? "production";

// log to file
log4js.configure({
    appenders: {
        out: {type: "stdout"},
        app: {
            type: "dateFile",
            filename: "logs/server",
            pattern: "yyyy-MM-dd.log",
            alwaysIncludePattern: true,
            compress: true,
            numBackups: 30
        },
    },
    categories: {
        default: {appenders: ["out", "app"], level: process.env.LOG_LEVEL || "info"}
    },
});
logger.info("Server starting...");

/*======== middleware =========*/
app.use(log4js.connectLogger(logger, {level: "auto"}));
app.use(express.json());
app.use(express.urlencoded({extended: true}));
logger.info("Loaded middleware");
/*======== End of middleware =======*/

/*======= router ======*/
// path: /ping
app.get("/ping", (req, res) => {
    res.json({code: 200, message: "pong"});
});

// path: /*
app.use("/", require("./routes"));
logger.info("Loaded /");
/*======== End of the route =======*/

// start server
let server: http.Server;
(async () => {
    await connectRedis();
    await openDB();
    await restoreRedis();

    // Start HTTP server
    server = app.listen(PORT, HOST, () => {
        figlet.text("EE3070 Server", {
            font: "ANSI Shadow",
            horizontalLayout: "full",
            verticalLayout: "full",
        }, function (err, data) {
            if (err) return;
            logger.info("\n" + data);
            logger.info(`Server running at ${HOST}:${PORT}`);
        });
    });
})();


// handle exit
function stop_server() {
    logger.info("Stopping server...");
    // close server
    server.close(async () => {
        logger.log("Server closed.");

        await closeDB();
        await disconnectRedis();
        await shutdownQuestionGenerateTaskQueue();

        figlet.text("See ya!", {
            font: "ANSI Shadow",
            horizontalLayout: "full",
            verticalLayout: "full",
        }, function (err, data) {
            if (err) return;
            logger.info("\n" + data);
            process.exit(0);
        });
    });
}

process.on("SIGINT", stop_server);
process.on("SIGTERM", stop_server);
process.on("beforeExit", stop_server);