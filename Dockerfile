# Quadro de tarefas em contêiner: painel web + API. Dados em /data (monte um volume).
# O MCP continua rodando onde o Claude Code roda; veja "Docker" no README para ligar os dois.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    CLAUDE_TASKS_HOST=0.0.0.0 \
    CLAUDE_TASKS_PORT=4317 \
    CLAUDE_TASKS_DB=/data/tasks.db \
    CLAUDE_TASKS_NO_OS_NOTIFY=1

COPY package.json package-lock.json ./
# Só a dependência opcional (SDK da Anthropic, usada pelo chat com chave de API).
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY bin ./bin

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- --header="Host: localhost:4317" http://127.0.0.1:4317/api/auth/me >/dev/null || exit 1

CMD ["node", "--no-warnings", "src/server.js"]
