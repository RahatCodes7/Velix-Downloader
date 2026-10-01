FROM node:20-slim

# ffmpeg is provided by ffmpeg-static, install python + PO token provider for never-fail bypass
RUN apt-get update && apt-get install -y python3 python-is-python3 python3-pip curl && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/bin/python \
 && python --version && python3 --version \
 && pip install --break-system-packages bgutil-ytdlp-pot-provider --no-cache-dir \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get update && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/* \
 && npm install -g bun --force \
 && bun --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

# Fly.io expects PORT 8080
EXPOSE 8080
CMD ["node", "src/index.js"]
