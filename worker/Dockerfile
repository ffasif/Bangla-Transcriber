# Production Dockerfile for Bangla Transcriber Worker
FROM node:20-bullseye-slim

# Install system FFmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

ENV PORT=4000
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 4000

CMD ["node", "server.js"]
