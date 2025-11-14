# Use Node.js LTS (Long Term Support) slim image as base
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -s /bin/false appuser

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY server.js ./
COPY public/ ./public/

# Set correct ownership
RUN chown -R appuser:appuser /usr/src/app

# Switch to non-root user
USER appuser

# Expose the port the app runs on
EXPOSE 8080

# Health check using Node.js
HEALTHCHECK --interval=30s --timeout=3s \
    CMD node -e "const http = require('http'); \
                 const options = { \
                   host: 'localhost', \
                   port: 8080, \
                   timeout: 2000, \
                   path: '/' \
                 }; \
                 const request = http.get(options, (res) => { \
                   console.log('STATUS: ' + res.statusCode); \
                   process.exit(res.statusCode === 200 ? 0 : 1); \
                 }); \
                 request.on('error', (err) => { \
                   console.error('ERROR', err); \
                   process.exit(1); \
                 });"

# Start the application
CMD [ "node", "server.js" ] 