FROM node:22.21.1-alpine3.21
LABEL authors="cocomine"
LABEL version="1.0.0"
LABEL description="CocomineAPI VPN Microservice"
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info
ENV REDIS_URL="redis://redis:6379"
ENV ENVOPENROUTER_KEY=""
ENV S3_ENDPOINT=""
ENV S3_ACCESS_KEY_ID=""
ENV S3_SECRET_ACCESS_KEY=""
ENV S3_PUBLIC_URL=""
ENV LLM_MODEL="openai/gpt-5-mini"

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable
RUN yarn install
COPY /dist ./

ENTRYPOINT ["node", "index.js"]