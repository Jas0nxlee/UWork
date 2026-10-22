# 单文件产物的运行镜像：先 `pnpm --filter @zcode/relay build`，再用本包目录做构建上下文
# （`docker build -t uwork-relay:dev packages/relay`），不需要整个 monorepo 参与镜像构建。
FROM node:24-alpine

WORKDIR /app
COPY dist/entry.js /app/entry.js

# 容器里必须监听 0.0.0.0；默认值 127.0.0.1 是给「本机调试」用的。
ENV RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787 \
    RELAY_WS_PATH=/ws \
    RELAY_STATE_FILE=/data/relay-state.json

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8787
VOLUME ["/data"]

# 不用 curl：镜像里只有 node。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/entry.js"]
