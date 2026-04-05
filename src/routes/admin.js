const express = require('express');
const { isAdmin } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');
const { DockerService } = require('../services/docker');

const router = express.Router();

router.get('/users', isAdmin, async (req, res) => {
    try {
        const users = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, username, role, created_at FROM users ORDER BY created_at DESC`,
                (err, rows) => {
                    if (err) reject(err);
                    resolve((rows || []).map(user => ({
                        id: user.id,
                        username: user.username,
                        role: user.role,
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

router.delete('/users/:userId', isAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await new Promise((resolve, reject) => {
            db.get('SELECT role FROM users WHERE id = ?', [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin users' });

        const runningContainers = await new Promise((resolve, reject) => {
            db.all(
                "SELECT container_id FROM containers WHERE user_id = ? AND status = 'running'",
                [userId],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });

        for (const c of runningContainers) {
            try {
                await DockerService.stopContainer(c.container_id);
            } catch (e) {
                logger.error('Error stopping container during user deletion:', e);
            }
        }

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM task_completions WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err); resolve();
            });
        });
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM containers WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err); resolve();
            });
        });
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM exercise_progress WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err); resolve();
            });
        });
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM active_sessions WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err); resolve();
            });
        });
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
                if (err) reject(err); resolve();
            });
        });

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        logger.error('Error deleting user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/users/:userId/progress', isAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await new Promise((resolve, reject) => {
            db.get('SELECT id, username FROM users WHERE id = ?', [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) return res.status(404).json({ error: 'User not found' });

        const images = await new Promise((resolve, reject) => {
            db.all('SELECT id, name, level, metadata FROM docker_images ORDER BY level, name', (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
            });
        });

        const progress = [];
        for (const img of images) {
            let metadata = {};
            try { metadata = JSON.parse(img.metadata || '{}'); } catch (e) { /* ignore */ }
            const goals = metadata.goals || [];

            const ep = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM exercise_progress WHERE user_id = ? AND image_id = ?',
                    [userId, img.id],
                    (err, row) => { if (err) reject(err); resolve(row); }
                );
            });

            const completedTasks = await new Promise((resolve, reject) => {
                db.all(
                    'SELECT task_id, completed_at, evidence FROM task_completions WHERE user_id = ? AND image_id = ?',
                    [userId, img.id],
                    (err, rows) => { if (err) reject(err); resolve(rows || []); }
                );
            });

            const containerLaunches = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT COUNT(*) as count FROM containers WHERE user_id = ? AND image_id = ?',
                    [userId, img.id],
                    (err, row) => { if (err) reject(err); resolve(row?.count || 0); }
                );
            });

            progress.push({
                exercise_name: img.name,
                level: img.level,
                status: ep?.status || 'not_started',
                attempts: ep?.attempts || 0,
                completed_at: ep?.completed_at || null,
                container_launches: containerLaunches,
                tasks_completed: completedTasks.length,
                tasks_total: goals.length,
                tasks: goals.map(g => {
                    const ct = completedTasks.find(t => t.task_id === g.id);
                    return {
                        id: g.id,
                        description: g.description,
                        completed: !!ct,
                        completed_at: ct?.completed_at || null
                    };
                })
            });
        }

        res.json({ user: { id: user.id, username: user.username }, progress });
    } catch (error) {
        logger.error('Error getting user progress:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/results', isAdmin, async (req, res) => {
    try {
        const users = await new Promise((resolve, reject) => {
            db.all(
                "SELECT id, username, role FROM users WHERE role = 'user' ORDER BY username",
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });

        const images = await new Promise((resolve, reject) => {
            db.all('SELECT id, name, level, metadata FROM docker_images ORDER BY level, name', (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
            });
        });

        const results = [];
        for (const user of users) {
            const exercises = [];
            for (const img of images) {
                let metadata = {};
                try { metadata = JSON.parse(img.metadata || '{}'); } catch (e) { /* ignore */ }
                const totalTasks = (metadata.goals || []).length;

                const completedCount = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND image_id = ?',
                        [user.id, img.id],
                        (err, row) => { if (err) reject(err); resolve(row?.count || 0); }
                    );
                });

                const ep = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT status, attempts, completed_at FROM exercise_progress WHERE user_id = ? AND image_id = ?',
                        [user.id, img.id],
                        (err, row) => { if (err) reject(err); resolve(row); }
                    );
                });

                exercises.push({
                    exercise_id: img.id,
                    exercise_name: img.name,
                    level: img.level,
                    status: ep?.status || 'not_started',
                    attempts: ep?.attempts || 0,
                    completed_at: ep?.completed_at || null,
                    tasks_completed: completedCount,
                    tasks_total: totalTasks
                });
            }

            results.push({
                user_id: user.id,
                username: user.username,
                exercises
            });
        }

        res.json({ results });
    } catch (error) {
        logger.error('Error getting results:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/stats', isAdmin, async (req, res) => {
    try {
        const stats = await new Promise((resolve, reject) => {
            db.get(
                `SELECT
                    (SELECT COUNT(*) FROM users WHERE role != 'admin') as total_users,
                    (SELECT COUNT(*) FROM docker_images) as total_exercises,
                    (SELECT COUNT(*) FROM containers WHERE status = 'running') as active_containers,
                    (SELECT COUNT(*) FROM exercise_progress WHERE status = 'completed') as total_completions,
                    (SELECT COUNT(*) FROM task_completions) as total_task_completions`,
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

router.get('/containers', isAdmin, async (req, res) => {
    try {
        const containers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT
                    c.*,
                    u.username,
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

router.post('/containers/:containerId/stop', isAdmin, async (req, res) => {
    try {
        const { containerId } = req.params;
        await DockerService.stopContainer(containerId);
        res.json({ message: 'Container stopped successfully' });
    } catch (error) {
        logger.error('Error stopping container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/images/health', isAdmin, async (req, res) => {
    try {
        const health = await DockerService.getImageHealth();
        res.json({ images: health });
    } catch (error) {
        logger.error('Error getting image health:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/logs', isAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 1000;
        const eventType = req.query.event_type;

        let query = `SELECT l.*, u.username
                     FROM system_logs l
                     LEFT JOIN users u ON l.user_id = u.id`;
        const params = [];

        if (eventType) {
            query += ' WHERE l.event_type = ?';
            params.push(eventType);
        }

        query += ' ORDER BY l.created_at DESC LIMIT ?';
        params.push(limit);

        const logs = await new Promise((resolve, reject) => {
            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        res.json({ logs });
    } catch (error) {
        logger.error('Error getting logs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/sessions', isAdmin, async (req, res) => {
    try {
        const sessions = await new Promise((resolve, reject) => {
            db.all(
                `SELECT s.*, u.username, u.role as user_role
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

router.post('/sessions/:sessionId/terminate', isAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM active_sessions WHERE session_id = ?', [sessionId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.json({ message: 'Session terminated successfully' });
    } catch (error) {
        logger.error('Error terminating session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = { router };
