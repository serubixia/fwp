FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV PORT=3000
ENV WORKSPACE_ROOT=/workspace
ENV FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

EXPOSE 3000

CMD ["node", "src/server.mjs"]
