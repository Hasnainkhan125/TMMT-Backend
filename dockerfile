# =========================
# 1️⃣ Builder (Node deps)
# =========================
FROM node:20.11.1-bullseye AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# =========================
# 2️⃣ Runtime — Node + Python + ffmpeg (for competitor teardown pipeline)
# =========================
FROM node:20.11.1-bullseye-slim

# ffmpeg, Python, pip, build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      python3-dev \
      build-essential \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python pipeline deps (cached layer)
COPY services/adSpec/requirements.txt /tmp/py-requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/py-requirements.txt

# Pre-warm Whisper base model so first teardown is instant (not a cold download)
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')" || true

ENV NODE_ENV=production
ENV PORT=5001
ENV PYTHON_BIN=python3
ENV WHISPER_MODEL=base

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app ./

RUN mkdir -p /app/uploads

EXPOSE 5001

CMD ["node", "index.js"]
