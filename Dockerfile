# Backend for Render: Express API + review screen (Node)
# and the team's Python stages.

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Root Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Task B reader dependencies
# Keep dev dependencies because TypeScript is needed to build reader/lib/
COPY reader/package.json reader/package-lock.json ./reader/
RUN cd reader && npm ci

# Python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy application source
COPY . .

# Build Task B TypeScript reader into reader/lib/
RUN cd reader && npm run build

# Public, results-only demo.
# Raw organiser emails and attachments are excluded by .dockerignore.
# deploy/results-seed.json contains the sanitised processed results.

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