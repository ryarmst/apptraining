const express = require('express');
const { isAdmin } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');
const { DockerService } = require('../services/docker');

const router = express.Router();

router.get('/stats', isAdmin, async (req, res) => {
    try {
        const stats = await new Promise((resolve, reject) => {
            db.get(
                `SELECT
                    (SELECT COUNT(*) FROM docker_images) as total_exercises,
                    (SELECT COUNT(*) FROM containers WHERE status = 'running') as active_containers,
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
                `SELECT c.*, di.name as exercise_name, di.level
                 FROM containers c
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

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'training.local';

router.get('/challenges', isAdmin, async (req, res) => {
    try {
        const { imageId } = req.query;

        const imageQuery = imageId
            ? 'SELECT * FROM docker_images WHERE id = ? ORDER BY level, name'
            : 'SELECT * FROM docker_images ORDER BY level, name';
        const imageParams = imageId ? [imageId] : [];

        const images = await new Promise((resolve, reject) => {
            db.all(imageQuery, imageParams, (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });

        const exercises = [];
        for (const img of images) {
            let metadata = {};
            try { metadata = JSON.parse(img.metadata || '{}'); } catch (e) { /* ignore */ }
            const goals = metadata.goals || [];

            const containers = await new Promise((resolve, reject) => {
                db.all(
                    `SELECT container_id, subdomain, status, created_at
                     FROM containers
                     WHERE image_id = ?
                     ORDER BY created_at DESC`,
                    [img.id],
                    (err, rows) => { if (err) reject(err); else resolve(rows || []); }
                );
            });

            const enrichedContainers = [];
            for (const c of containers) {
                const completions = await new Promise((resolve, reject) => {
                    db.all(
                        'SELECT task_id, completed_at, evidence FROM task_completions WHERE container_id = ?',
                        [c.container_id],
                        (err, rows) => { if (err) reject(err); else resolve(rows || []); }
                    );
                });

                const completionMap = {};
                for (const t of completions) completionMap[t.task_id] = t;

                const completedGoalCompletions = goals
                    .map(g => completionMap[g.id])
                    .filter(Boolean);
                const tasksCompleted = completedGoalCompletions.length;
                const tasksTotal = goals.length;
                const solved = tasksTotal > 0 && tasksCompleted >= tasksTotal;
                const solvedAt = solved
                    ? completedGoalCompletions
                        .map(t => new Date(t.completed_at))
                        .reduce((latest, current) => current > latest ? current : latest)
                    : null;
                const startedAt = new Date(c.created_at);
                const solveDurationMs = solvedAt ? solvedAt.getTime() - startedAt.getTime() : null;

                enrichedContainers.push({
                    container_id: c.container_id,
                    subdomain: c.subdomain,
                    url: `${c.subdomain}.${PLATFORM_DOMAIN}`,
                    status: c.status,
                    created_at: c.created_at,
                    solved,
                    solved_at: solvedAt ? solvedAt.toISOString() : null,
                    solve_duration_ms: solveDurationMs,
                    solve_duration_minutes: solveDurationMs !== null ? Math.max(0, Math.round(solveDurationMs / 60000)) : null,
                    tasks_completed: tasksCompleted,
                    tasks_total: tasksTotal,
                    tasks: goals.map(g => ({
                        id: g.id,
                        description: g.description,
                        hint: g.hint || null,
                        completed: !!completionMap[g.id],
                        completed_at: completionMap[g.id]?.completed_at || null,
                        evidence: completionMap[g.id]?.evidence || null
                    }))
                });
            }

            exercises.push({
                id: img.id,
                name: img.name,
                level: img.level,
                description: img.description,
                containers: enrichedContainers
            });
        }

        res.json({ exercises });
    } catch (error) {
        logger.error('Error getting challenges:', error);
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

        let query = 'SELECT * FROM system_logs';
        const params = [];

        if (eventType) {
            query += ' WHERE event_type = ?';
            params.push(eventType);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
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
