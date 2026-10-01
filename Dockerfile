ARG NODE_IMAGE=node:24.16.0-bookworm
FROM ${NODE_IMAGE} AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV NODE_USE_ENV_PROXY=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libsecret-1-dev unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.8.1
COPY . .
RUN --mount=type=cache,id=webide-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm build:all \
    && pnpm exec esbuild application/server/main.ts --bundle --platform=node --format=esm --packages=external \
       --banner:js="import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);" \
       --outfile=application/server/main.mjs
RUN --mount=type=cache,id=webide-extensions,target=/app/.cache/extension-downloads \
    pnpm download-extension \
    && node scripts/build-extension-manifest.cjs tools/extensions builtin-extensions.manifest.json \
    && node scripts/verify-extensions.cjs
RUN pnpm exec tsx --eval "import { runtimeFingerprint } from './application/server/runtime.ts'; import { writeFile } from 'node:fs/promises'; runtimeFingerprint(process.cwd()).then(value => writeFile('.runtime-fingerprint', value));"

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libsecret-1-0 zsh curl ca-certificates git unzip util-linux python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production OPENSUMI_RUNTIME_MODE=node \
    WORKBENCH_LOCAL_DEMO=0 WORKBENCH_RUNTIME_DRIVER=sandbox \
    WORKBENCH_HOST=0.0.0.0 WORKBENCH_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8790
CMD ["node", "application/server/main.mjs"]
