FROM node:22-bookworm-slim AS whisperx-builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    NLTK_DATA=/opt/nltk_data

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# The service only uses WhisperX alignment helpers, so we avoid installing the
# full ASR/diarization dependency tree and force CPU-only torch wheels.
RUN python3 -m venv /opt/whisperx \
  && /opt/whisperx/bin/pip install --upgrade pip \
  && /opt/whisperx/bin/pip install \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    "torch~=2.8.0" \
    "torchaudio~=2.8.0" \
  && /opt/whisperx/bin/pip install \
    "huggingface-hub<1.0.0" \
    "nltk>=3.9.1" \
    "numpy>=2.1.0" \
    "pandas>=2.2.3" \
    "transformers>=4.48.0" \
  && /opt/whisperx/bin/pip install --no-deps whisperx==3.8.5 \
  && /opt/whisperx/bin/python -c "import nltk; nltk.download('punkt_tab', quiet=True, download_dir='/opt/nltk_data')" \
  && find /opt/whisperx -type d -name '__pycache__' -prune -exec rm -rf '{}' + \
  && find /opt/whisperx -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete \
  && rm -rf /opt/whisperx/bin/pip* /opt/whisperx/lib/python3.*/site-packages/pip*

FROM node:22-bookworm-slim AS app-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=app-deps /app/node_modules ./node_modules
COPY src ./src
COPY --from=whisperx-builder /opt/whisperx /opt/whisperx
COPY --from=whisperx-builder /opt/nltk_data /opt/nltk_data

ENV PORT=3000
ENV WORKSPACE_ROOT=/workspace
ENV FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
ENV NLTK_DATA=/opt/nltk_data
ENV WHISPERX_PYTHON=/opt/whisperx/bin/python
ENV WHISPERX_DEVICE=cpu
ENV WHISPERX_DEFAULT_LANGUAGE=es

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "const http = require('node:http'); const port = Number(process.env.PORT || 3000); const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (response) => { response.resume(); response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1)); }); request.on('timeout', () => request.destroy(new Error('timeout'))); request.on('error', () => process.exit(1));"]

EXPOSE 3000

CMD ["node", "src/server.mjs"]
