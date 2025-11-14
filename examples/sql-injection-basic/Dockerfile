FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p public/css

# Set environment variables
ENV NODE_ENV=production
ENV APP_PORT=8080

# Add exercise completion script
COPY check-completion.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/check-completion.sh

# Expose port
EXPOSE 8080

# Start the application
CMD ["npm", "start"] 