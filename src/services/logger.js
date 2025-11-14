const { db } = require('../db/init');
const { logger } = require('../utils/logger');

class SystemLogger {
    static async logEvent(eventType, userId, targetId, details) {
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO system_logs (event_type, user_id, target_id, details) VALUES (?, ?, ?, ?)',
                [eventType, userId, targetId, JSON.stringify(details)],
                (err) => {
                    if (err) {
                        logger.error('Error logging event:', err);
                        reject(err);
                    }
                    resolve();
                }
            );
        });
    }

    static async trackSession(sessionId, userId, req) {
        const ipAddress = req.ip;
        const userAgent = req.headers['user-agent'];

        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                
                // Delete any existing session with this ID
                db.run(
                    'DELETE FROM active_sessions WHERE session_id = ?',
                    [sessionId],
                    (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            logger.error('Error removing existing session:', err);
                            reject(err);
                            return;
                        }
                        
                        // Insert the new session
                        db.run(
                            `INSERT INTO active_sessions 
                            (session_id, user_id, ip_address, user_agent) 
                            VALUES (?, ?, ?, ?)`,
                            [sessionId, userId, ipAddress, userAgent],
                            (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    logger.error('Error tracking session:', err);
                                    reject(err);
                                    return;
                                }
                                
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        db.run('ROLLBACK');
                                        reject(err);
                                        return;
                                    }
                                    resolve();
                                });
                            }
                        );
                    }
                );
            });
        });
    }

    static async removeSession(sessionId) {
        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM active_sessions WHERE session_id = ?',
                [sessionId],
                (err) => {
                    if (err) {
                        logger.error('Error removing session:', err);
                        reject(err);
                    }
                    resolve();
                }
            );
        });
    }

    static async cleanupExpiredSessions() {
        const expiryTime = new Date(Date.now() - (24 * 60 * 60 * 1000)); // 24 hours ago

        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM active_sessions WHERE last_activity < ?',
                [expiryTime.toISOString()],
                (err) => {
                    if (err) {
                        logger.error('Error cleaning up expired sessions:', err);
                        reject(err);
                        return;
                    }
                    resolve();
                }
            );
        });
    }

    static async updateSessionActivity(sessionId) {
        return new Promise((resolve, reject) => {
            db.run(
                'UPDATE active_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = ?',
                [sessionId],
                (err) => {
                    if (err) {
                        logger.error('Error updating session activity:', err);
                        reject(err);
                        return;
                    }
                    resolve();
                }
            );
        });
    }
}

module.exports = { SystemLogger }; 