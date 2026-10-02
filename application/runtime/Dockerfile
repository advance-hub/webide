# 先使用仓库根 Dockerfile 构建 opensumi-webide-node:dev。
ARG OPENSUMI_BASE=opensumi-webide-node:dev
FROM maven:3.9.16-eclipse-temurin-21 AS java-tools
FROM eclipse-temurin:8-jdk-jammy AS java8
FROM eclipse-temurin:11-jdk-jammy AS java11
FROM eclipse-temurin:17-jdk-jammy AS java17
FROM ${OPENSUMI_BASE}
USER root
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV NODE_USE_ENV_PROXY=1
COPY --from=java-tools /opt/java/openjdk /opt/java/openjdk
COPY --from=java-tools /usr/share/maven /opt/maven
ENV JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/opt/maven \
    PATH=/opt/java/openjdk/bin:/opt/maven/bin:${PATH}
RUN test "$(java -version 2>&1 | sed -n '1s/.*\"\([0-9]*\)\..*/\1/p')" = 21 \
  && mvn -version | grep -q 'Apache Maven 3.9.16'
ARG OPENCODE_VERSION=1.18.32
RUN npm install --prefix /opt/opensumi/opencode --omit=dev --no-audit --no-fund \
      "opencode-ai@${OPENCODE_VERSION}" \
  && npm install --prefix /opt/opensumi/opencode-config --omit=dev --no-audit --no-fund \
      "@opencode-ai/plugin@${OPENCODE_VERSION}" \
  && mkdir -p /opt/opensumi/bin \
  && ln -s ../opencode/node_modules/.bin/opencode /opt/opensumi/bin/opencode \
  && /opt/opensumi/bin/opencode --version | grep -Fx "${OPENCODE_VERSION}" \
  && test "$(node -p "require('/opt/opensumi/opencode-config/node_modules/@opencode-ai/plugin/package.json').version")" = "${OPENCODE_VERSION}"
ARG OH_MY_ZSH_COMMIT=74965c96098134b192f00084f966b4b02438a739
RUN git init -q /opt/oh-my-zsh \
  && git -C /opt/oh-my-zsh remote add origin https://github.com/ohmyzsh/ohmyzsh.git \
  && git -C /opt/oh-my-zsh fetch --depth 1 origin "$OH_MY_ZSH_COMMIT" \
  && git -C /opt/oh-my-zsh checkout -q FETCH_HEAD \
  && rm -rf /opt/oh-my-zsh/.git \
  && test -f /opt/oh-my-zsh/oh-my-zsh.sh \
  && command -v flock && command -v curl && /bin/zsh --version \
  && test -f /app/builtin-extensions.manifest.json \
  && test -d /app/builtin-extensions.manifest.json.d
# 频繁修改的入口放在工具安装层之后，减少镜像重新构建成本。
COPY --from=java8 /opt/java/openjdk /opt/java/8
COPY --from=java11 /opt/java/openjdk /opt/java/11
COPY --from=java17 /opt/java/openjdk /opt/java/17
RUN /opt/java/8/bin/java -version && /opt/java/11/bin/java -version && /opt/java/17/bin/java -version
COPY application/runtime/start-workspace.sh /opt/opensumi/bin/start-workspace
COPY application/runtime/default-settings.json /opt/opensumi/default-settings.json
COPY application/runtime/zshrc /opt/opensumi/default-zshrc
COPY application/runtime/ensure-default-settings.cjs /opt/opensumi/bin/ensure-default-settings.cjs
COPY application/runtime/opencode.json /opt/opensumi/opencode.json
COPY application/runtime/stop-ide.cjs /opt/opensumi/bin/stop-ide.cjs
COPY application/runtime/development.cjs /opt/opensumi/bin/development.cjs
COPY application/runtime/maven.cjs /opt/opensumi/bin/maven.cjs
COPY application/runtime/maven-metadata.py /opt/opensumi/bin/maven-metadata.py
COPY application/runtime/editor-connections.cjs /opt/opensumi/bin/editor-connections.cjs
COPY application/runtime/command-input.cjs /opt/opensumi/bin/command-input.cjs
COPY application/runtime/git.cjs application/runtime/git-credential.cjs /opt/opensumi/bin/
COPY application/runtime/toolchain.cjs application/runtime/tool-versions.cjs application/runtime/maven-config.cjs /opt/opensumi/bin/
COPY application/runtime/services.cjs application/runtime/restore-machine.cjs application/runtime/machine-archive.cjs /opt/opensumi/bin/
COPY application/runtime/personal-settings.cjs application/runtime/preferences.cjs application/runtime/machine.cjs /opt/opensumi/bin/
RUN chmod 0755 /opt/opensumi/bin/start-workspace && sh -n /opt/opensumi/bin/start-workspace
ENV HOME=/workspace/home \
    PORT=4317 \
    MY_WORKSPACE=/workspace/project \
    WORKBENCH_MACHINE_HOME=/workspace/home \
    WORKBENCH_LOCAL_DEMO=1 \
    MAX_EXTENSION_HOSTS=5 \
    MAX_MANAGED_EXTENSION_PROCESSES=5 \
    ENABLE_COLLABORATION=1 \
    COLLABORATION_TRANSPORT=shared \
    ENABLE_AI=1
WORKDIR /app
# OpenSandbox 注入 execd 并覆盖入口；控制面
# 完成卷挂载和仓库准备后再启动 OpenSumi。
CMD ["sleep", "infinity"]
