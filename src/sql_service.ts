import {getLogger} from "log4js";
import sqlite3 from "sqlite3";
import {Database, open} from "sqlite";

const logger = getLogger('sqlite');

export let DB: Database;

// Create a MySQL connection pool
export async function openDB() {
    try {
        DB = await open({
            filename: 'database.db',
            driver: sqlite3.Database
        });
        await DB.exec("PRAGMA foreign_keys = ON;");
        const fkState = await DB.get<{ foreign_keys: number }>("PRAGMA foreign_keys;");
        logger.info(`SQLite database opened. foreign_keys=${fkState?.foreign_keys ?? "unknown"}.`);
    } catch (err) {
        logger.error('Failed to open SQLite database.', err);
        throw err;
    }
}

export async function closeDB(): Promise<void> {
    if (!DB) return;
    try {
        await DB.close();
        logger.info('SQLite closed successfully.');
    } catch (err) {
        logger.error('SQLite closed fail.', err);
    }
}
