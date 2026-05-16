# Use Node.js LTS on Debian (needed for apt-get)
FROM node:20-slim

# Install Python3, ffmpeg, curl, and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp binary directly from GitHub
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /app

# Copy package files and install Node deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Create downloads directory
RUN mkdir -p /app/downloads

# Expose port
EXPOSE 3000

# Update yt-dlp to absolute latest on every start, then run server
CMD yt-dlp -U 2>/dev/null || true && node server.js
