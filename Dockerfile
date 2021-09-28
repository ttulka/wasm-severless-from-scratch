FROM node:15.14-slim
WORKDIR /app/
COPY index.js ./
COPY worker.js ./
ENV PATH_TO_MODULES=/app/wasm
EXPOSE 8000
VOLUME ["/app/wasm"]
ENTRYPOINT ["node", "index.js"]
