const express = require('express');
const { DockerService } = require('../services/docker');
const { isAuthenticated } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');

const router = express.Router();

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'apptraining.dbg.local';
const MAX_CONTAINERS = parseInt(process.env.MAX_CONTAINERS_PER_USER, 10) || 3;

router.get('/', isAuthenticated, async (req, res) => {
    try {
        const containers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT c.*, i.name as image_name, i.level, i.description
                 FROM containers c
                 JOIN docker_images i ON c.image_id = i.id
                 WHERE c.user_id = ? AND c.status = 'running'
                 ORDER BY c.created_at DESC`,
                [req.session.userId],
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

router.post('/launch/:imageId', isAuthenticated, async (req, res) => {
    try {
        const { imageId } = req.params;

        const existingContainer = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM containers WHERE user_id = ? AND image_id = ? AND status = ?',
                [req.session.userId, imageId, 'running'],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (existingContainer) {
            return res.status(400).json({
                error: 'Container already running for this exercise',
                containerId: existingContainer.container_id,
                subdomain: `${existingContainer.subdomain}.${PLATFORM_DOMAIN}`,
                message: 'You already have a running instance of this exercise. Please stop it first.'
            });
        }

        const runningContainers = await new Promise((resolve, reject) => {
            db.get(
                'SELECT COUNT(*) as count FROM containers WHERE user_id = ? AND status = ?',
                [req.session.userId, 'running'],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (runningContainers.count >= MAX_CONTAINERS) {
            return res.status(400).json({
                error: 'Maximum container limit reached',
                message: `You can only have ${MAX_CONTAINERS} active containers at a time. Please stop an existing container first.`
            });
        }

        const containerInfo = await DockerService.createContainer(imageId, req.session.userId);

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT OR REPLACE INTO exercise_progress (user_id, image_id, status, attempts)
                 VALUES (?, ?, 'in_progress', COALESCE((SELECT attempts + 1 FROM exercise_progress
                 WHERE user_id = ? AND image_id = ?), 1))`,
                [req.session.userId, imageId, req.session.userId, imageId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.json(containerInfo);
    } catch (error) {
        logger.error('Error launching container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:containerId/stop', isAuthenticated, async (req, res) => {
    try {
        const { containerId } = req.params;

        const container = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM containers WHERE container_id = ? AND user_id = ?',
                [containerId, req.session.userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (!container) {
            return res.status(404).json({ error: 'Container not found' });
        }

        await DockerService.stopContainer(containerId);
        res.json({ message: 'Container stopped successfully' });
    } catch (error) {
        logger.error('Error stopping container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = { router };
