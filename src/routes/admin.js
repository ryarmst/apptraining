const express = require('express');
const { isAdmin } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');

const router = express.Router();

// Get all users
router.get('/users', isAdmin, async (req, res) => {
    try {
        const users = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, username, role, created_at
                 FROM users
                 WHERE role != 'admin'
                 ORDER BY created_at DESC`,
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows.map(user => ({
                        id: user.id,
                        username: user.username,
                        isAdmin: user.role === 'admin',
                        createdAt: user.created_at
                    })));
                }
            );
        });

        res.json({ users });
    } catch (error) {
        logger.error('Error getting users:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete user
router.delete('/users/:userId', isAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if user exists and is not an admin
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT role FROM users WHERE id = ?', [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (user.role === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin users' });
        }

        // Delete user's containers
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM containers WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        // Delete user's progress
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM exercise_progress WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        // Delete user
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        logger.error('Error deleting user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get detailed user progress
router.get('/users/:userId/progress', isAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        const progress = await new Promise((resolve, reject) => {
            db.all(
                `SELECT 
                    di.name as exercise_name,
                    di.level,
                    ep.status,
                    ep.attempts,
                    ep.completed_at,
                    (SELECT COUNT(*) FROM containers 
                     WHERE user_id = ? AND image_id = di.id) as container_launches
                 FROM docker_images di
                 LEFT JOIN exercise_progress ep ON di.id = ep.image_id AND ep.user_id = ?
                 ORDER BY di.level, di.name`,
                [userId, userId],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ progress });
    } catch (error) {
        logger.error('Error getting user progress:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get system statistics
router.get('/stats', isAdmin, async (req, res) => {
    try {
        const stats = await new Promise((resolve, reject) => {
            db.get(
                `SELECT
                    (SELECT COUNT(*) FROM users WHERE role != 'admin') as total_users,
                    (SELECT COUNT(*) FROM docker_images) as total_exercises,
                    (SELECT COUNT(*) FROM containers WHERE status = 'running') as active_containers,
                    (SELECT COUNT(*) FROM exercise_progress WHERE status = 'completed') as total_completions`,
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        res.json({ stats });
    } catch (error) {
        logger.error('Error getting system stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get active containers across all users
router.get('/containers', isAdmin, async (req, res) => {
    try {
        const containers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT 
                    c.*,
                    u.username as user_email,
                    di.name as exercise_name,
                    di.level
                 FROM containers c
                 JOIN users u ON c.user_id = u.id
                 JOIN docker_images di ON c.image_id = di.id
                 WHERE c.status = 'running'
                 ORDER BY c.created_at DESC`,
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ containers });
    } catch (error) {
        logger.error('Error getting containers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Force stop a container
router.post('/containers/:containerId/stop', isAdmin, async (req, res) => {
    try {
        const { containerId } = req.params;
        const { DockerService } = require('../services/docker');

        await DockerService.stopContainer(containerId);
        res.json({ message: 'Container stopped successfully' });
    } catch (error) {
        logger.error('Error stopping container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get system logs
router.get('/logs', isAdmin, async (req, res) => {
    try {
        const logs = await new Promise((resolve, reject) => {
            db.all(
                `SELECT 
                    l.*,
                    u.username as user_email
                 FROM system_logs l
                 LEFT JOIN users u ON l.user_id = u.id
                 ORDER BY l.created_at DESC
                 LIMIT 1000`,
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ logs });
    } catch (error) {
        logger.error('Error getting logs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get active sessions
router.get('/sessions', isAdmin, async (req, res) => {
    try {
        const sessions = await new Promise((resolve, reject) => {
            db.all(
                `SELECT 
                    s.*,
                    u.username as user_email,
                    u.role as user_role
                 FROM active_sessions s
                 JOIN users u ON s.user_id = u.id
                 ORDER BY s.last_activity DESC`,
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ sessions });
    } catch (error) {
        logger.error('Error getting sessions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Terminate session
router.post('/sessions/:sessionId/terminate', isAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM active_sessions WHERE session_id = ?',
                [sessionId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.json({ message: 'Session terminated successfully' });
    } catch (error) {
        logger.error('Error terminating session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = { router }; 