# 128bit Tracker server: one small container, one SQLite file in /data.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8128 \
    TRACKER_DB=/data/tracker.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8128
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
