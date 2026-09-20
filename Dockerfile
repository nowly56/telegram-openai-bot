FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY bot.mjs reports.mjs storage.mjs memory.mjs schedule-language.mjs delivery.mjs bot_prompt.txt ./

RUN mkdir -p /data

ENV NODE_ENV=production
ENV CONTEXT_FILE=/data/chat-context.json

CMD ["npm", "start"]
