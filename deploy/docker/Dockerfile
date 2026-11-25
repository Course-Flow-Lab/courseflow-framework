ARG NODE_IMAGE=node:24-bookworm-slim
ARG RUST_IMAGE=rust:1.88-bookworm

FROM ${RUST_IMAGE} AS zhs-build
WORKDIR /build/zhs
COPY courseflow-zhs/ ./
RUN cargo test --locked && cargo build --release --locked

FROM ${NODE_IMAGE} AS node-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY framework/package.json framework/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG FRAMEWORK_REVISION
ARG ZHS_REVISION
ARG CX_REVISION
LABEL org.opencontainers.image.title="Courseflow API" \
      org.opencontainers.image.revision="${FRAMEWORK_REVISION}" \
      io.github.course-flow-lab.zhs-revision="${ZHS_REVISION}" \
      io.github.course-flow-lab.cx-revision="${CX_REVISION}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-noto-cjk python3 python3-venv tar \
    && rm -rf /var/lib/apt/lists/*
COPY courseflow-chaoxing/requirements.txt /opt/cx-requirements.txt
RUN python3 -m venv /opt/cx-venv \
    && /opt/cx-venv/bin/pip install --no-cache-dir -r /opt/cx-requirements.txt
WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY framework/package.json ./
COPY framework/src ./src
COPY framework/LICENSE ./LICENSE
COPY courseflow-zhs/courseflow.module.json courseflow-zhs/LICENSE /opt/courseflow-modules/zhs/
COPY --from=zhs-build /build/zhs/target/release/courseflow-zhs /opt/courseflow-modules/zhs/target/release/courseflow-zhs
COPY courseflow-chaoxing/courseflow.module.json courseflow-chaoxing/main.py \
     courseflow-chaoxing/requirements.txt courseflow-chaoxing/LICENSE courseflow-chaoxing/NOTICE.md /opt/courseflow-modules/cx/
COPY courseflow-chaoxing/cx /opt/courseflow-modules/cx/cx
COPY deploy/entrypoint.sh /usr/local/bin/courseflow-entrypoint
RUN chmod 755 /usr/local/bin/courseflow-entrypoint /opt/courseflow-modules/cx/main.py \
    && chmod -R a+rX /app /opt/courseflow-modules \
    && mkdir /data && chown node:node /data
ENV NODE_ENV=production CF_DATA_DIR=/data CF_BIND=0.0.0.0:8101 \
    CF_CHROMIUM=/usr/bin/chromium PATH="/opt/cx-venv/bin:${PATH}"
USER node
EXPOSE 8101
ENTRYPOINT ["/usr/local/bin/courseflow-entrypoint"]
CMD ["node", "src/main.ts", "serve"]
