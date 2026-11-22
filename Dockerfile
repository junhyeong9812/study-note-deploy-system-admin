FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 테스트 — 배포 전에 ci-cd agent 가 `docker build --target test` 로 실행한다 (실패하면 배포 안 함)
FROM node:22-alpine AS test
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm test

# 빌드 + 클라이언트 산출물 검사(비밀값 이름·테스트용 비밀값이 브라우저로 가는 묶음에 없어야 한다)
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && sh scripts/check-client-bundle.sh .next/static

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# 배포된 컨테이너 안에서 실제 환경 변수 값으로 클라이언트 산출물을 검사하는 데 쓴다(README "값 검사")
COPY --from=build --chown=node:node /app/scripts/check-client-bundle.sh ./scripts/check-client-bundle.sh
USER node
EXPOSE 18000
ENV PORT=18000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
