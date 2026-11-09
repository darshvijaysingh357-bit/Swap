FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir /data && chown node:node /data
ENV DB_PATH=/data/usage.db
VOLUME /data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
