const sqlite3 = require('sqlite3').verbose();
const argon2 = require('argon2');
const { logger } = require('../utils/logger');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'training.db');
const db = new sqlite3.Database(dbPath);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

const initializeDatabase = async () => {
    try {
        await runAsync('PRAGMA journal_mode = WAL');
        await runAsync('PRAGMA foreign_keys = ON');

        await runAsync(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT CHECK(role IN ('admin', 'user')) NOT NULL DEFAULT 'user',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await runAsync(`CREATE TABLE IF NOT EXISTS docker_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            description TEXT,
            level TEXT CHECK(level IN ('beginner', 'intermediate', 'advanced')) NOT NULL,
            image_id TEXT UNIQUE NOT NULL,
            metadata JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await runAsync(`CREATE TABLE IF NOT EXISTS containers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            container_id TEXT UNIQUE NOT NULL,
            image_id INTEGER,
            subdomain TEXT UNIQUE NOT NULL,
            callback_token TEXT NOT NULL,
            status TEXT CHECK(status IN ('running', 'stopped', 'completed')) NOT NULL,
            host_port TEXT,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(image_id) REFERENCES docker_images(id)
        )`);

        await runAsync(`CREATE TABLE IF NOT EXISTS task_completions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id INTEGER NOT NULL,
            container_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            evidence TEXT,
            FOREIGN KEY(image_id) REFERENCES docker_images(id),
            UNIQUE(container_id, task_id)
        )`);

        // Migrate task_completions if it still has the old user_id column
        const tcCols = await new Promise((resolve, reject) => {
            db.all('PRAGMA table_info(task_completions)', (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });
        if (tcCols.some(c => c.name === 'user_id')) {
            logger.info('Migrating task_completions schema...');
            await runAsync(`CREATE TABLE task_completions_v2 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL,
                container_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                evidence TEXT,
                FOREIGN KEY(image_id) REFERENCES docker_images(id),
                UNIQUE(container_id, task_id)
            )`);
            await runAsync(`INSERT OR IGNORE INTO task_completions_v2
                (id, image_id, container_id, task_id, completed_at, evidence)
                SELECT id, image_id, container_id, task_id, completed_at, evidence
                FROM task_completions`);
            await runAsync('DROP TABLE task_completions');
            await runAsync('ALTER TABLE task_completions_v2 RENAME TO task_completions');
            logger.info('task_completions migration completed');
        }

        // Migrate containers if it still has the old user_id column
        const cCols = await new Promise((resolve, reject) => {
            db.all('PRAGMA table_info(containers)', (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });
        if (cCols.some(c => c.name === 'user_id')) {
            logger.info('Migrating containers schema...');
            await runAsync(`CREATE TABLE containers_v2 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                container_id TEXT UNIQUE NOT NULL,
                image_id INTEGER,
                subdomain TEXT UNIQUE NOT NULL,
                callback_token TEXT NOT NULL,
                status TEXT CHECK(status IN ('running', 'stopped', 'completed')) NOT NULL,
                host_port TEXT,
                last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(image_id) REFERENCES docker_images(id)
            )`);
            await runAsync(`INSERT OR IGNORE INTO containers_v2
                (id, container_id, image_id, subdomain, callback_token, status, host_port, last_activity, created_at)
                SELECT id, container_id, image_id, subdomain, callback_token, status, host_port, last_activity, created_at
                FROM containers`);
            await runAsync('DROP TABLE containers');
            await runAsync('ALTER TABLE containers_v2 RENAME TO containers');
            logger.info('containers migration completed');
        }

        await runAsync(`CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            user_id INTEGER,
            target_id TEXT,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        await runAsync(`CREATE TABLE IF NOT EXISTS active_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        const hashedPassword = await argon2.hash(ADMIN_PASSWORD, {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 4,
            saltLength: 16
        });

        await runAsync(
            `INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, 'admin')`,
            [ADMIN_USERNAME, hashedPassword]
        );

        logger.info('Database initialized successfully');
    } catch (error) {
        logger.error('Database initialization failed:', error);
        throw error;
    }
};

module.exports = {
    db,
    runAsync,
    initializeDatabase
}; 