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

默认数据目录 `application/.data/` 包含 SQLite 元数据、加密凭据密钥、仓库和开发机文件。保留这些文件才能保留工作区状态；停止服务并不删除工作区。工作区重置会重新检出固定基线，属于显式文件操作。

## 工作台配置

根启动命令读取 `application/.env`，示例文件可直接复制。直接执行 `pnpm --filter @opensumi/application start` 时，需要调用方自行加载环境变量。

| 变量                                        | 默认值 / 用途                                                 |
| ------------------------------------------- | ------------------------------------------------------------- |
| `WORKBENCH_HOST` / `WORKBENCH_PORT`         | `127.0.0.1` / `8790`                                          |
| `WORKBENCH_LOCAL_DEMO`                      | `1`，本机管理员模式，只允许绑定回环地址                       |
| `WORKBENCH_RUNTIME_DRIVER`                  | `local`；远程隔离运行使用 `sandbox`                           |
| `WORKBENCH_DATA_DIR`                        | `application/.data/`                                          |
| `WORKBENCH_PUBLIC_URL`                      | `http://127.0.0.1:8790`，使用其他入口时显式设置               |
| `WORKBENCH_IDE_HOST`                        | `localhost`，用于工作区域名                                   |
| `WORKBENCH_MACHINE_LIMIT`                   | `20`，每台个人开发机的工作区上限，允许 `1..20`                |
| `OPENSUMI_NODE_WATCHER_MODE`                | `per-client`；`shared` 为实验共享模式                         |
| `WORKBENCH_ADMIN_USERS`                     | 非演示模式管理员账户标识，以逗号分隔                          |
| `WORKBENCH_DOCKER_CONTEXT`                  | 本机镜像管理使用的 Docker context                             |
| `OPEN_SANDBOX_URL` / `OPEN_SANDBOX_API_KEY` | 已部署的 OpenSandbox 服务地址与凭据                           |
| `OPEN_SANDBOX_IMAGE`                        | 包含本版 IDE 和 `/opt/opensumi/bin/start-workspace` 的镜像    |
| `OPEN_SANDBOX_CPU` / `OPEN_SANDBOX_MEMORY`  | `2` / `2Gi`                                                   |
| `WORKBENCH_STORAGE_MODE`                    | `pvc` 或 `retained`                                           |
| `WORKBENCH_STORAGE_CLASS`                   | PVC 存储类别，空值由服务端决定                                |
| `WORKBENCH_VOLUME_BACKEND`                  | 默认 `external`；同一 Docker daemon 上的受管卷可配置 `docker` |

`pvc` 使用持久卷并保留终止后的数据；`retained` 将文件保存在保留的沙箱中，原沙箱丢失时拒绝创建空环境覆盖记录。`external` 卷后端尚未实现自动删除 PVC，释放会明确失败，需要补齐相应后端能力。完整 OpenSandbox 镜像和真实远程运行仍待部署验收，当前 SDK 测试使用协议夹具。

本机 driver 使用当前操作系统身份启动 IDE，当前验收范围是回环地址上的本机管理。多账户隔离与公开部署需要另行验收。Maven 工作区还需要匹配的 JDK、Maven 或项目 Wrapper；目前部分 Maven 元数据解析保留 Python 辅助程序。

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
