# Use Node.js 20 LTS on Debian slim
FROM node:20-slim

# Install ffmpeg for audio conversion (no yt-dlp needed — we use Piped API)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

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

# Start server
CMD ["node", "server.js"]
