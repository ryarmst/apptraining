const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const tar = require('tar');
const AdmZip = require('adm-zip');
const { isAdmin } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker();

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const dir = './uploads/exercises';
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.zip' || ext === '.tar' || ext === '.gz' || file.originalname.endsWith('.tar.gz') || ext === '.tgz') {
            cb(null, true);
        } else {
            cb(new Error('Only .zip, .tar, .tar.gz, and .tgz files are allowed'));
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.get('/', isAdmin, async (req, res) => {
    try {
        const exercises = await new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM docker_images ORDER BY level, name',
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });

        const enriched = exercises.map(ex => {
            let metadata = {};
            try { metadata = JSON.parse(ex.metadata || '{}'); } catch (e) { /* ignore */ }
            const goals = metadata.goals || [];
            return {
                id: ex.id,
                name: ex.name,
                version: ex.version,
                description: ex.description,
                level: ex.level,
                created_at: ex.created_at,
                tasks_total: goals.length
            };
        });

        res.json({ exercises: enriched });
    } catch (error) {
        logger.error('Error getting exercises:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/upload', isAdmin, upload.single('exercise'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        logger.info('File upload:', {
            originalName: req.file.originalname,
            size: req.file.size,
            path: req.file.path
        });

        const uploadPath = req.file.path;
        const extractPath = path.join('./uploads/exercises', path.parse(req.file.filename).name);

        await fs.mkdir(extractPath, { recursive: true });

        try {
            if (req.file.originalname.match(/\.(tar\.gz|tgz)$/)) {
                await tar.x({ file: uploadPath, cwd: extractPath });
            } else if (req.file.originalname.endsWith('.tar')) {
                await tar.x({ file: uploadPath, cwd: extractPath });
            } else if (req.file.originalname.endsWith('.zip')) {
                const zip = new AdmZip(uploadPath);
                zip.extractAllTo(extractPath, true);
            }
        } catch (extractError) {
            throw new Error('Failed to extract exercise files: ' + extractError.message);
        }

        const files = await fs.readdir(extractPath);

        if (!files.includes('Dockerfile')) {
            throw new Error('Missing required file: Dockerfile');
        }
        if (!files.includes('metadata.json')) {
            throw new Error('Missing required file: metadata.json');
        }

        const metadataContent = await fs.readFile(path.join(extractPath, 'metadata.json'), 'utf8');

        let metadata;
        try {
            metadata = JSON.parse(metadataContent);
        } catch (parseError) {
            throw new Error('Invalid metadata.json format: ' + parseError.message);
        }

        if (!metadata.title) throw new Error('Missing required metadata field: title');
        if (!metadata.description) throw new Error('Missing required metadata field: description');
        if (!metadata.level) throw new Error('Missing required metadata field: level');

        const validLevels = ['beginner', 'intermediate', 'advanced'];
        const levelValue = metadata.level.toLowerCase();
        if (!validLevels.includes(levelValue)) {
            throw new Error('Level must be one of: beginner, intermediate, advanced');
        }

        if (metadata.goals && Array.isArray(metadata.goals)) {
            for (const goal of metadata.goals) {
                if (!goal.id || !goal.description) {
                    throw new Error('Each goal must have an "id" and "description"');
                }
            }
        }

        const imageTag = `training/${metadata.title.toLowerCase().replace(/\s+/g, '-')}:${metadata.version || 'latest'}`;

        logger.info('Starting Docker build:', { imageTag, extractPath });

        const tarStream = await tar.c({ gzip: true, cwd: extractPath }, files);
        const stream = await docker.buildImage(tarStream, {
            t: imageTag,
            dockerfile: 'Dockerfile'
        });

        await new Promise((resolve, reject) => {
            docker.modem.followProgress(stream, (err, output) => {
                if (err) {
                    reject(new Error('Docker build failed: ' + err.message));
                    return;
                }
                const errors = output.filter(item => item.error || item.errorDetail);
                if (errors.length > 0) {
                    const errorMessage = errors.map(e => e.error || e.errorDetail.message).join('; ');
                    reject(new Error('Docker build failed: ' + errorMessage));
                    return;
                }
                logger.info('Docker build completed:', { imageTag });
                resolve(output);
            }, (event) => {
                if (event.stream) {
                    logger.info('Build:', event.stream.trim());
                }
            });
        });

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO docker_images (name, version, description, level, image_id, metadata)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    metadata.title,
                    metadata.version || 'latest',
                    metadata.description,
                    levelValue,
                    imageTag,
                    JSON.stringify(metadata)
                ],
                function (err) {
                    if (err) { reject(err); return; }
                    logger.info('Database insert successful:', this.lastID);
                    resolve();
                }
            );
        });

        try {
            await fs.rm(extractPath, { recursive: true });
            await fs.unlink(uploadPath);
        } catch (cleanupError) {
            logger.error('Cleanup error:', cleanupError);
        }

        res.json({
            message: 'Exercise uploaded successfully',
            image: {
                name: metadata.title,
                version: metadata.version || 'latest',
                tag: imageTag,
                tasks: (metadata.goals || []).length
            }
        });
    } catch (error) {
        logger.error('Error uploading exercise:', error);
        if (req.file) {
            try {
                await fs.unlink(req.file.path);
                const extractPath = path.join('./uploads/exercises', path.parse(req.file.filename).name);
                await fs.rm(extractPath, { recursive: true, force: true });
            } catch (cleanupError) {
                logger.error('Error cleaning up after failed upload:', cleanupError);
            }
        }
        res.status(400).json({ error: error.message });
    }
});

router.put('/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, level, version } = req.body;

        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE docker_images
                 SET name = ?, description = ?, level = ?, version = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [name, description, level, version, id],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.json({ message: 'Exercise updated successfully' });
    } catch (error) {
        logger.error('Error updating exercise:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const image = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM docker_images WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!image) {
            return res.status(404).json({ error: 'Exercise not found' });
        }

        const runningContainers = await new Promise((resolve, reject) => {
            db.all(
                "SELECT container_id FROM containers WHERE image_id = ? AND status = 'running'",
                [id],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });

        if (runningContainers.length > 0) {
            return res.status(400).json({
                error: `Cannot delete exercise with ${runningContainers.length} running container(s). Stop them first.`
            });
        }

        try {
            const dockerImage = docker.getImage(image.image_id);
            await dockerImage.remove({ force: true });
        } catch (error) {
            logger.warn('Docker image removal failed (may already be removed):', error.message);
        }

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM task_completions WHERE image_id = ?', [id], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM containers WHERE image_id = ?', [id], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM docker_images WHERE id = ?', [id], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.json({ message: 'Exercise deleted successfully' });
    } catch (error) {
        logger.error('Error deleting exercise:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = { router };
