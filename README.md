# webide

基于 [OpenSumi](https://github.com/opensumi/core) 的 Web IDE 重建版，使用 Node.js 24、pnpm、TypeScript 7 和 Rspack。工作台控制面使用 Koa 3，负责项目、个人开发机、工作区和 IDE 入口；框架与扩展 API 保留 OpenSumi 兼容性。

当前是本机可运行的迁移开发版。工作台和真实 Node IDE 已通过本机验证；远程 OpenSandbox 通过官方 SDK 协议测试，完整远程部署、Docker 镜像和上游 CI 仍需补齐。具体进度见 [迁移状态](docs/MIGRATION.md)。

## 工具链

| 工具                  | 固定版本 |
| --------------------- | -------- |
| Node.js               | 24.16.0  |
| pnpm                  | 12.8.1   |
| TypeScript 原生编译器 | 7.0.2    |
| Rspack core / CLI     | 2.2.8    |
| Rspack dev server     | 2.2.1    |
| 工作台 Koa            | 3.2.1    |

`.node-version`、`.nvmrc`、Volta 和 `packageManager` 固定运行版本。框架编译使用 TypeScript 7；依赖旧编译器 API 的 ts-loader、ts-jest 和 AST 工具通过 `typescript-api` 使用兼容的 TypeScript 6.0.2。两者的职责见 [运行说明](docs/RUNNING.md)。

## 快速启动

先安装 Node.js 24.16.0，以及 Git、curl 和本机原生模块构建工具；原生依赖可能需要 Python 3 与 C/C++ 编译器。

```sh
npm install --global pnpm@12.8.1

git clone https://github.com/advance-hub/webide.git
cd webide
pnpm install --frozen-lockfile
cp application/.env.example application/.env

pnpm download-extension
node scripts/build-extension-manifest.cjs tools/extensions builtin-extensions.manifest.json
pnpm start
```

打开 [本机工作台](http://127.0.0.1:8790)。首次启动会校验源码与构建产物，并自动补齐构建；内置插件下载支持缓存、断点续传和摘要校验，首次下载可能较慢。

默认使用本机管理员模式和本机 Node IDE，工作台只监听回环地址。项目导入后，可创建分支工作区、启动 IDE、停止或重启；普通停止与启动保留未提交文件。数据默认位于 `application/.data/`，配置、凭据和数据均不进入 Git。

## 开发与验证

```sh
pnpm dev                     # 工作台 UI 8792，API 8790
pnpm dev:ide                 # 独立 IDE：前端 8080，Node 服务 8000
pnpm run build:all           # 框架、宿主、IDE 服务、IDE 客户端及工作台构建
pnpm run test:workbench      # 工作台测试，包含真实 Node IDE 启停与代理
pnpm run typecheck:scripts   # 工程脚本类型检查
node scripts/verify-extensions.cjs
```

完整安装、端口、配置、沙箱与 Git 远程设置见 [运行说明](docs/RUNNING.md)。前后端入口分别位于 [client](client/README.md)、[server](server/README.md)，工作台代码位于 `application/`。

## 共享 Node watcher

默认仍按连接启动 watcher；实验模式需要显式设置：

```sh
OPENSUMI_NODE_WATCHER_MODE=shared pnpm start
```

共享仅限同一个 IDE Server 的多个连接，独立工作区 Server 不会跨进程共享。移植后的 39 个 watcher 测试、3 轮五连接实盘验证通过；整棵 IDE 的内存和延迟改善仍未验收。详见 [共享 watcher 说明](docs/architecture/shared-node-watcher.md)及其中保留的原项目实验记录。

## 来源与许可证

本仓库保留 OpenSumi 的 Git 历史和包命名空间，初始上游基线为 `9a7057aec`。`origin` 指向 `advance-hub/webide`，OpenSumi 远程保留为 `upstream`。

项目沿用 [MIT License](LICENSE)，第三方声明见 [NOTICE.md](NOTICE.md)。感谢 OpenSumi 及相关扩展与依赖的维护者。
