const sqlite3 = require('sqlite3').verbose();
const argon2 = require('argon2');
const { logger } = require('../utils/logger');
const path = require('path');

const dbPath = path.join(__dirname, '../../data/training.db');
const db = new sqlite3.Database(dbPath);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'adminRyan';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const initializeDatabase = () => {
    return new Promise((resolve, reject) => {
        db.serialize(async () => {
            try {
                // Users table
                db.run(`CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    role TEXT CHECK(role IN ('admin', 'user')) NOT NULL DEFAULT 'user',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`);

                // Docker images table
                db.run(`CREATE TABLE IF NOT EXISTS docker_images (
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

                // Containers table
                db.run(`CREATE TABLE IF NOT EXISTS containers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    container_id TEXT UNIQUE NOT NULL,
                    image_id INTEGER,
                    user_id INTEGER,
                    subdomain TEXT UNIQUE NOT NULL,
                    status TEXT CHECK(status IN ('running', 'stopped', 'completed')) NOT NULL,
                    host_port TEXT,
                    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(image_id) REFERENCES docker_images(id),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);

                // Progress tracking table
                db.run(`CREATE TABLE IF NOT EXISTS exercise_progress (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    image_id INTEGER,
                    status TEXT CHECK(status IN ('not_started', 'in_progress', 'completed')) DEFAULT 'not_started',
                    attempts INTEGER DEFAULT 0,
                    completed_at DATETIME,
                    FOREIGN KEY(user_id) REFERENCES users(id),
                    FOREIGN KEY(image_id) REFERENCES docker_images(id),
                    UNIQUE(user_id, image_id)
                )`);

                // System logs table
                db.run(`CREATE TABLE IF NOT EXISTS system_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    user_id INTEGER,
                    target_id TEXT,
                    details TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);

                // Active sessions table
                db.run(`CREATE TABLE IF NOT EXISTS active_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT UNIQUE NOT NULL,
                    user_id INTEGER NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);

                // Create admin user if it doesn't exist
                const hashedPassword = await argon2.hash(ADMIN_PASSWORD, {
                    type: argon2.argon2id,
                    memoryCost: 65536, // 64MB
                    timeCost: 3, // 3 iterations
                    parallelism: 4,
                    saltLength: 16
                });
                
                db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, 'admin')`,
                    [ADMIN_USERNAME, hashedPassword]);

                logger.info('Database initialized successfully');
                resolve();
            } catch (error) {
                logger.error('Database initialization failed:', error);
                reject(error);
            }
        });
    });
};

module.exports = {
    db,
    initializeDatabase
}; 