const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const tar = require('tar');
const AdmZip = require('adm-zip');
const { isAuthenticated, isAdmin } = require('../routes/auth');
const { logger } = require('../utils/logger');
const { db } = require('../db/init');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: './uploads/exercises',
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        // Handle both .tar.gz and .tgz extensions
        if (ext === '.zip' || ext === '.tar' || ext === '.gz' || file.originalname.endsWith('.tar.gz') || ext === '.tgz') {
            cb(null, true);
        } else {
            cb(new Error('Only .zip, .tar, .tar.gz, and .tgz files are allowed'));
        }
    },
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Get all exercises
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const exercises = await new Promise((resolve, reject) => {
            db.all(
                `SELECT i.*, 
                 (SELECT status FROM exercise_progress WHERE user_id = ? AND image_id = i.id) as status,
                 (SELECT attempts FROM exercise_progress WHERE user_id = ? AND image_id = i.id) as attempts
                 FROM docker_images i
                 ORDER BY i.level, i.name`,
                [req.session.userId, req.session.userId],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ exercises });
    } catch (error) {
        logger.error('Error getting exercises:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Upload new exercise
router.post('/upload', isAdmin, upload.single('exercise'), async (req, res) => {
    try {
        logger.info('Starting exercise upload process');
        
        if (!req.file) {
            logger.error('Upload failed: No file provided');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        logger.info('File upload details:', {
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path
        });

        const uploadPath = req.file.path;
        const extractPath = path.join('./uploads/exercises', path.parse(req.file.filename).name);

        logger.info('Extraction paths:', {
            uploadPath,
            extractPath
        });

        // Create extraction directory
        await fs.mkdir(extractPath, { recursive: true });
        logger.info('Created extraction directory');

        try {
            // Extract uploaded file based on type
            if (req.file.originalname.match(/\.(tar\.gz|tgz)$/)) {
                logger.info('Extracting tar.gz/tgz file');
                await tar.x({
                    file: uploadPath,
                    cwd: extractPath
                });
            } else if (req.file.originalname.endsWith('.tar')) {
                logger.info('Extracting tar file');
                await tar.x({
                    file: uploadPath,
                    cwd: extractPath
                });
            } else if (req.file.originalname.endsWith('.zip')) {
                logger.info('Extracting zip file');
                const zip = new AdmZip(uploadPath);
                zip.extractAllTo(extractPath, true);
            }
            logger.info('File extraction completed');
        } catch (extractError) {
            logger.error('Extraction error:', extractError);
            throw new Error('Failed to extract exercise files: ' + extractError.message);
        }

        // Validate exercise structure
        const files = await fs.readdir(extractPath);
        logger.info('Extracted files:', files);

        if (!files.includes('Dockerfile')) {
            logger.error('Missing Dockerfile');
            throw new Error('Missing required file: Dockerfile');
        }
        if (!files.includes('metadata.json')) {
            logger.error('Missing metadata.json');
            throw new Error('Missing required file: metadata.json');
        }

        // Read and validate metadata
        const metadataContent = await fs.readFile(path.join(extractPath, 'metadata.json'), 'utf8');
        logger.info('Read metadata.json:', metadataContent);
        
        let metadata;
        try {
            metadata = JSON.parse(metadataContent);
            logger.info('Parsed metadata:', metadata);
        } catch (parseError) {
            logger.error('Metadata parse error:', parseError);
            throw new Error('Invalid metadata.json format: ' + parseError.message);
        }

        if (!metadata.title) {
            logger.error('Missing metadata.title');
            throw new Error('Missing required metadata field: title');
        }
        if (!metadata.description) {
            logger.error('Missing metadata.description');
            throw new Error('Missing required metadata field: description');
        }
        if (!metadata.level) {
            logger.error('Missing metadata.level');
            throw new Error('Missing required metadata field: level');
        }

        // Validate level format
        const validLevels = ['beginner', 'intermediate', 'advanced'];
        const levelValue = metadata.level.toLowerCase();
        
        if (!validLevels.includes(levelValue)) {
            logger.error('Invalid level value:', metadata.level);
            throw new Error('Level must be one of: beginner, intermediate, advanced');
        }

        // Build Docker image
        const imageTag = `training/${metadata.title.toLowerCase().replace(/\s+/g, '-')}:${metadata.version || 'latest'}`;
        try {
            logger.info('Starting Docker build:', { imageTag, extractPath });
            
            // List files in build context
            const buildFiles = await fs.readdir(extractPath);
            logger.info('Files in build context:', buildFiles);

            // Read Dockerfile content
            const dockerfileContent = await fs.readFile(path.join(extractPath, 'Dockerfile'), 'utf8');
            logger.info('Dockerfile content:', dockerfileContent);
            
            // Create tar stream from the build context
            const tarStream = await tar.c(
                {
                    gzip: true,
                    cwd: extractPath
                },
                files
            );

            const stream = await docker.buildImage(tarStream, {
                t: imageTag,
                dockerfile: 'Dockerfile'
            });

            // Process the build stream
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(stream, (err, res) => {
                    if (err) {
                        logger.error('Docker build failed:', err);
                        reject(new Error('Docker build failed: ' + err.message));
                        return;
                    }
                    
                    // Check for build errors in the output
                    const errors = res.filter(item => item.error || item.errorDetail);
                    if (errors.length > 0) {
                        const errorMessage = errors.map(e => e.error || e.errorDetail.message).join('; ');
                        logger.error('Docker build error in output:', errors);
                        reject(new Error('Docker build failed: ' + errorMessage));
                        return;
                    }
                    
                    logger.info('Docker build completed successfully:', { imageTag });
                    resolve(res);
                }, (event) => {
                    if (event.stream) {
                        logger.info('Docker build progress:', event.stream.trim());
                    }
                });
            });

            // Save image details to database
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
                    function(err) {
                        if (err) {
                            logger.error('Database insert error:', err);
                            reject(err);
                            return;
                        }
                        logger.info('Database insert successful:', this.lastID);
                        resolve();
                    }
                );
            });

            // Clean up
            try {
                await fs.rm(extractPath, { recursive: true });
                await fs.unlink(uploadPath);
                logger.info('Cleanup completed');
            } catch (cleanupError) {
                logger.error('Cleanup error:', cleanupError);
                // Don't throw here, as the upload was successful
            }

            res.json({
                message: 'Exercise uploaded successfully',
                image: {
                    name: metadata.title,
                    version: metadata.version || 'latest',
                    tag: imageTag
                }
            });
        } catch (buildError) {
            logger.error('Docker build error:', buildError);
            throw new Error('Failed to build Docker image: ' + buildError.message);
        }
    } catch (error) {
        logger.error('Error uploading exercise:', error);
        // Clean up on error
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

// Update exercise metadata
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

// Delete exercise
router.delete('/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get image details
        const image = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM docker_images WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!image) {
            return res.status(404).json({ error: 'Exercise not found' });
        }

        // Remove Docker image
        try {
            const dockerImage = docker.getImage(image.image_id);
            await dockerImage.remove({ force: true });
        } catch (error) {
            logger.error('Error removing Docker image:', error);
        }

        // Remove from database
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