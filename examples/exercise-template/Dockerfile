FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r appuser && useradd -r -g appuser -s /bin/false appuser

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

COPY check-completion.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/check-completion.sh

RUN chown -R appuser:appuser /usr/src/app
USER appuser

ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
    CMD curl -f http://localhost:8080/ || exit 1

CMD ["node", "app.js"] 