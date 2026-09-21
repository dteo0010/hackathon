# Backend for Render: Express API + review screen (Node) and the team's Python stages (A, C).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY . .

# Public, results-only demo. The organisers' emails and attachments are NOT in this image
# (see .dockerignore); deploy/results-seed.json holds the processed results for all 520
# emails, made with scripts/make-public-seed.mjs (no document text, one evidence line per field).
# Secrets (GEMINI_API_KEY) and CORS_ORIGINS are set in the Render dashboard, never here.
ENV NODE_ENV=production \
    PUBLIC_DEMO=1 \
    PIPELINE_DATA=Bundle \
    PIPELINE_STAGES=src/stages.js#stagesFor \
    PIPELINE_DB=/tmp/pipeline-db.json \
    PIPELINE_SEED_DB=deploy/results-seed.json \
    SDOC_CLASSIFIER=baseline \
    PYTHON=python3

EXPOSE 3000
CMD ["node", "--no-deprecation", "src/server.js"]
