const express = require('express');
const { DockerService } = require('../services/docker');
const { isAdmin } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');

const router = express.Router();

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'training.local';

router.get('/', isAdmin, async (req, res) => {
    try {
        const containers = await new Promise((resolve, reject) => {
            db.all(
                `SELECT c.*, i.name as image_name, i.level, i.description
                 FROM containers c
                 JOIN docker_images i ON c.image_id = i.id
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

router.post('/launch/:imageId', isAdmin, async (req, res) => {
    try {
        const { imageId } = req.params;
        const containerInfo = await DockerService.createContainer(imageId, req.session.userId);
        res.json(containerInfo);
    } catch (error) {
        logger.error('Error launching container:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:containerId/stop', isAdmin, async (req, res) => {
    try {
        const { containerId } = req.params;

        const container = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM containers WHERE container_id = ?',
                [containerId],
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
