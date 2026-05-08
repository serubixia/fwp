FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/whisperx \
  && /opt/whisperx/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/whisperx/bin/pip install --no-cache-dir whisperx==3.8.5 \
  && /opt/whisperx/bin/python -c "import nltk; nltk.download('punkt_tab', quiet=True)"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=3000
ENV WORKSPACE_ROOT=/workspace
ENV FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
ENV WHISPERX_PYTHON=/opt/whisperx/bin/python
ENV WHISPERX_DEVICE=cpu
ENV WHISPERX_DEFAULT_LANGUAGE=es

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "const http = require('node:http'); const port = Number(process.env.PORT || 3000); const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (response) => { response.resume(); response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1)); }); request.on('timeout', () => request.destroy(new Error('timeout'))); request.on('error', () => process.exit(1));"]

EXPOSE 3000

CMD ["node", "src/server.mjs"]
