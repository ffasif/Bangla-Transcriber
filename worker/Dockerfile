# Production Dockerfile for Bangla Transcriber Worker
FROM node:20-bookworm-slim

# Install system FFmpeg from active Debian Bookworm repositories in a single layer
RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends --fix-missing ffmpeg ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

ENV PORT=4000
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 4000

CMD ["node", "server.js"]
