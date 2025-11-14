FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy exercise files
COPY . .

# Copy completion script
COPY check-completion.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/check-completion.sh

# Install dependencies
RUN npm install

# Initialize database with vulnerable app
RUN sqlite3 app.db < init.sql

# Set environment variables
ENV NODE_ENV=production
ENV APP_PORT=3000

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "app.js"] 