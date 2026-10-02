# 安装与运行

## 环境与安装

使用 Node.js `24.16.0`、pnpm `12.8.1`。仓库安装脚本拒绝其他 Node 主版本和其他包管理器。Git 与 curl 用于项目和内置插件下载；原生模块编译可能需要 Python 3、C/C++ 编译器和操作系统开发工具。

```sh
npm install --global pnpm@12.8.1
pnpm install --frozen-lockfile
cp application/.env.example application/.env
pnpm download-extension
node scripts/build-extension-manifest.cjs tools/extensions builtin-extensions.manifest.json
pnpm start
```

插件安装目录 `tools/extensions/`、下载缓存 `.cache/` 和生成的插件索引不提交。下载失败可重新执行同一命令继续；切换操作系统或 CPU 架构后应重新安装对应平台的插件，避免沿用不兼容的 Java/XML 原生组件。

## 入口与端口

| 命令                       | 行为                                                 | 默认地址                 |
| -------------------------- | ---------------------------------------------------- | ------------------------ |
| `pnpm start`               | 校验并构建产物，运行工作台及其托管能力               | `http://127.0.0.1:8790`  |
| `pnpm dev`                 | 工作台 API 与界面开发服务                            | UI `8792`，API `8790`    |
| `pnpm dev:ide`             | 独立 IDE 客户端和 Node 服务                          | 前端 `8080`，服务 `8000` |
| `pnpm run build:all`       | 框架、Worker、扩展宿主、IDE 服务和客户端、工作台构建 | 不监听端口               |
| `pnpm run check:artifacts` | 检查产物与源码、工具链是否匹配                       | 不修改产物               |
| `pnpm run test:workbench`  | 工作台集成与单元测试                                 | 使用临时目录和端口       |

工作台健康检查为 `GET /healthz`。工作区的 IDE 使用一次性入场凭据换取会话，通过独立工作区域名转发 HTTP 和 WebSocket；本机开发需要浏览器能解析 `*.localhost`。

托管工作区默认启用 Node/Yjs 协同。所有者可在卡片中邀请四名已登录成员，协同 WebSocket 复用工作区入口；权限、终端访问边界和五人验收说明见 [协同文档](COLLABORATION.md)。旧的运行实例不会在控制面升级时自动加载新协同模块：本机实例需重启，沙箱需配置本版镜像并更新运行时后重启。未更新的实例不能算本版五人验收结果。

默认数据目录 `application/.data/` 包含 SQLite 元数据、加密凭据密钥、仓库和开发机文件。保留这些文件才能保留工作区状态；停止服务并不删除工作区。工作区重置会重新检出固定基线，属于显式文件操作。

## 工作台配置

根启动命令读取 `application/.env`，示例文件可直接复制。直接执行 `pnpm --filter @opensumi/application start` 时，需要调用方自行加载环境变量。

| 变量 | 默认值 / 用途 |
| --- | --- |
| `WORKBENCH_HOST` / `WORKBENCH_PORT` | `127.0.0.1` / `8790` |
| `WORKBENCH_LOCAL_DEMO` | `1`，本机管理员模式，只允许绑定回环地址 |
| `WORKBENCH_RUNTIME_DRIVER` | `local`；远程隔离运行使用 `sandbox` |
| `WORKBENCH_DATA_DIR` | `application/.data/` |
| `WORKBENCH_PUBLIC_URL` | `http://127.0.0.1:8790`，使用其他入口时显式设置 |
| `WORKBENCH_IDE_HOST` | `localhost`，用于工作区域名 |
| `WORKBENCH_MACHINE_LIMIT` | `20`，每台个人开发机的工作区上限，允许 `1..20` |
| `OPENSUMI_NODE_WATCHER_MODE` | `per-client`；`shared` 为实验共享模式 |
| `WORKBENCH_ADMIN_USERS` | 非演示模式管理员账户标识，以逗号分隔 |
| `WORKBENCH_DOCKER_CONTEXT` | 本机镜像管理使用的 Docker context |
| `OPEN_SANDBOX_URL` / `OPEN_SANDBOX_API_KEY` | 已部署的 OpenSandbox 服务地址与凭据 |
| `OPEN_SANDBOX_IMAGE` | 包含本版 IDE 和 `/opt/opensumi/bin/start-workspace` 的镜像 |
| `OPEN_SANDBOX_CPU` / `OPEN_SANDBOX_MEMORY` | `2` / `2Gi` |
| `WORKBENCH_STORAGE_MODE` | `pvc` 或 `retained` |
| `WORKBENCH_STORAGE_CLASS` | PVC 存储类别，空值由服务端决定 |
| `WORKBENCH_VOLUME_BACKEND` | `external` / `docker` / `kubernetes` |
| `OPEN_SANDBOX_PLATFORM` | 空值由服务决定，可显式设置 `linux/amd64` 或 `linux/arm64`；镜像和官方组件架构需一致 |
| `OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS` | 初始创建/连接默认 `300` 秒，允许 `10..1200`，覆盖冷镜像解包 |
| `WORKBENCH_GIT_BRIDGE_URL` | 沙箱可访问的 Git 代理入口；非演示模式必须使用 HTTPS |
| `WORKBENCH_KUBERNETES_URL` | Kubernetes HTTPS API，空值使用集群内配置 |
| `WORKBENCH_KUBERNETES_NAMESPACE` | `default`；PVC 所在 namespace |
| `WORKBENCH_KUBERNETES_TOKEN_FILE` / `WORKBENCH_KUBERNETES_CA_FILE` | 受限 service account 的令牌和 CA 文件；空值使用集群内挂载 |

`pvc` 使用持久卷并保留终止后的数据；`retained` 将文件保存在保留的沙箱中，原沙箱丢失时拒绝创建空环境覆盖记录。`external` 明确拒绝自动删除；`docker` 删除同一 daemon 上的受管卷；`kubernetes` 使用 namespace、UID 和 resourceVersion 前置条件删除 PVC，拒绝活跃 Pod 挂载，等待对象消失才删除元数据。Docker 路径已完成真实 OpenSandbox 验收，Kubernetes 仅完成分页/UID/异步删除协议测试。升级只支持 PVC：`retained` 须先备份并迁移到 PVC，不能直接替换容器。

本机 driver 使用当前操作系统身份启动 IDE，只允许回环演示模式。关闭演示模式后必须使用 sandbox，配置校验拒绝共享本机 OS 身份的多账户部署。沙箱按账户开发机创建独立容器及卷；本机 Docker 双账户文件和 API 隔离已验证，公开部署的网关与身份接入仍需部署方验收。Maven 工作区还需要匹配的 JDK、Maven 或项目 Wrapper；目前部分 Maven 元数据解析保留 Python 辅助程序。

## 开发资源、Git 与开发机

资源页支持 Nacos、Redis、MySQL、RocketMQ、Elasticsearch、Middleware 和 COS。配置按账户加密存储；列表隐藏凭据，非演示模式读取凭据要求 HTTPS。探测验证协议或认证，不能代替完整业务可用性测试。COS 列表限定配置前缀，文本只读支持最多 64 KiB UTF-8。工作区启动会同步个人 MySQL/Redis 编辑器连接；共享成员工作区撤销个人连接，失败可通过工作区连接接口重试。

代码源配置包含 `provider`（`github`、`gitlab`、`gitee`）、URL、令牌与可选 Git 账户。导入地址必须匹配凭据源。IDE 获得机器/项目范围的独立桥接租约，不持有源 PAT；发布上传已提交的 Git bundle，验证分支、HEAD、基线后正常推送。未提交文件保留，非快进推送失败不会 force。创建 MR/PR 失败后保留已发布 SHA，重试先查已有开放请求。外部代码源真实账户未在本次验收中调用。

开发机备份先停止 IDE，保存受限归档、SHA-256 与 AES-256-GCM 密文，然后恢复之前就绪的工作区。文件和工作区元数据一起恢复；断电或控制面重启后任务显示 `needsRecovery`，须调用恢复任务收尾，再允许其他修改。加密备份依赖原控制面的凭据密钥和 SQLite，复制单独 `.enc` 文件不能恢复。

空闲策略默认 `idleMinutes=120`、`autoBackupHours=0`；0 表示关闭。每分钟检查，存在浏览器连接时不停止，自动备份只对全部停止的工作区执行并保留最近 5 份。缓存清理只处理受管缓存，Maven/工作区维护互斥；Linux 内存优先读 cgroup，其他平台读 OS 指标。

本机孤儿恢复通过 0600 身份日志、私有令牌、PID、工作区 ID 与真实目录核验，拒绝未验证进程。运行时升级会停同机工作区并实际构建或更换沙箱镜像，保留项目和脏文件；失败显示可恢复状态，不等同于普通 restart。

## Node 镜像与隔离验收

```sh
docker build -t opensumi-webide-node:dev .
docker build -f application/runtime/Dockerfile --build-arg OPENSUMI_BASE=opensumi-webide-node:dev -t opensumi-webide-workspace:dev .
WEBIDE_ACCEPTANCE_IMAGE=opensumi-webide-workspace:dev bash scripts/run-local-sandbox-acceptance.sh
WEBIDE_ACCEPTANCE_SUITE=collaboration WEBIDE_ACCEPTANCE_IMAGE=opensumi-webide-workspace:dev bash scripts/run-local-sandbox-acceptance.sh
```

基础镜像编译框架、IDE 和工作台，安装 70 个配置插件；沙箱镜像增加 Java 8/11/17/21、Maven 和运行辅助工具。OpenSandbox 注入 execd，控制面在准备仓库后执行 `/opt/opensumi/bin/start-workspace`。运行配置需提供已部署服务与镜像，单独启动基础镜像不会自动部署 OpenSandbox。

验收脚本固定官方 Server `0.2.3`、execd `1.1.0`、SDK `1.1.0` 和私有 Docker `29.3.0`，仅向回环随机端口暴露测试服务。它要求 Docker 允许启动 privileged DinD，创建专属 context、网络和数据卷，不切换默认 context，退出时清理专属资源。脚本默认读取工作区镜像架构，可用 `WEBIDE_ACCEPTANCE_PLATFORM=linux/amd64|linux/arm64` 显式指定；Server、execd 和 SDK 使用相同架构。脚本运行两账户的 IDE，验证真实 IDE HTTP/WS 代理、指标、加密备份与脏文件恢复、容器替换保留 PVC、实际容器和卷删除。升级夹具只改变镜像指纹，证明驱动执行了替换与识别，尚未验证跨两个发布版本的业务迁移。

镜像构建可通过 `NODE_IMAGE`、`HTTP_PROXY`、`HTTPS_PROXY` 参数适配镜像源与网络；不要将代理或密钥写入 Dockerfile。真实验收 JSON 与日志默认保存于忽略的 `output/runtime-profiles/node-control-plane-20261002/`，可通过 `WEBIDE_ACCEPTANCE_OUTPUT` 指定独立 JSON 输出，保留已有验收记录。入口会复用本机已缓存且架构匹配的固定版本官方镜像，缺失时再拉取。若使用已有远程服务，可按 `application/acceptance/opensandbox.ts` 的 `WEBIDE_ACCEPTANCE_*` 环境变量单独执行；该脚本会创建并释放测试开发机，必须指向隔离环境。

## TypeScript 与构建

`pnpm exec tsc` 和框架构建调用 TypeScript `7.0.2` 原生编译器。TypeScript 7 不提供旧 JavaScript Compiler API，因此 ts-loader、ts-jest 和 AST 工具使用别名 `typescript-api`，固定到 TypeScript `6.0.2`。这些 API 兼容消费者不替代 TypeScript 7 的框架编译与类型检查。

Rspack 使用统一的框架构建工厂和产品配置。修改源码后，根启动命令按摘要检查产物；过期时自动构建。内存不足时构建预检会失败，需先释放本机资源再重试。

## Git 远程与提交

此仓库已有 OpenSumi 历史，无需重复 `git init`。配置为：

```sh
git remote add upstream https://github.com/opensumi/core.git
git remote set-url origin https://github.com/advance-hub/webide.git
git push -u origin main
```

`upstream` 已存在时无需再次添加；从 GitHub 新克隆只会自动创建 `origin`，可按需增加上游远程。更新上游时先 `git fetch upstream`，再审查并合并对应变更。

提交使用 Conventional Commits，可写中文标题与正文。Git hooks 通过 pnpm 执行 lint-staged 和 commitlint；提交按功能拆分，运行数据、凭据、构建产物和本机性能原始记录不进入版本库。
