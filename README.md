# webide

基于 [OpenSumi](https://github.com/opensumi/core) 的 Web IDE 重建版，使用 Node.js 24、pnpm、TypeScript 7 和 Rspack。工作台控制面使用 Koa 3，负责项目、个人开发机、工作区和 IDE 入口；框架与扩展 API 保留 OpenSumi 兼容性。

当前版本使用 Node 控制面与 Node IDE，已删除 Go watcher/search、Gateway、协议、构建入口与 Go 插件。开发资源、Git 凭据桥与发布、开发机维护、运行时升级、孤儿恢复和卷删除均已接入。macOS 与本机 Docker 中的 Linux/OpenSandbox 已执行验收；Windows、真实 Kubernetes 和外部代码源/云资源仍需对应环境验收。具体范围见 [迁移状态](docs/MIGRATION.md)和 [控制面设计](docs/NODE-CONTROL-PLANE.md)。

## 性能量化与验收状态

2026-10-25 在本机 Linux ARM64 / OpenSandbox 中完成优化前后各三轮五人验收，交替顺序运行，360 份内存样本全部通过。两版采用相同可靠性修复、Node.js 24.16.0 和 70 个内置扩展，内存对照仅改变扩展配置快照与 TypeScript 单服务默认值。

下表为每轮 P95 的三轮中位数。独立场景为五台合计，单位 GiB；RSS 会重复计入共享页，PSS 按共享比例分摊，容器内存包括文件缓存，三者口径不同。

| 五人场景                 | IDE 进程树 RSS：前 → 后 | RSS 降低 | IDE 进程树 PSS：前 → 后 | 容器内存：前 → 后 |
| ------------------------ | ----------------------: | -------: | ----------------------: | ----------------: |
| 共享一个工作区           |             4.58 → 3.78 |    17.5% |             3.10 → 2.51 |       3.25 → 2.69 |
| 各自独立工作区，五台合计 |             5.23 → 4.46 |    14.6% |             3.53 → 2.95 |       3.82 → 3.40 |

主要收益来自 TypeScript 服务进程从十个降至五个，语法与语义由每个连接自己的单个服务处理；五个扩展宿主、十个其他语言服务、类型获取、诊断和补全均保留。扩展宿主总占用变化很小，不能用配置快照的隔离堆收益替代整树结果。

本轮同时修复源码扩展宿主启动和直接依赖、高亮任务取消拒绝、补全文档版本竞态及协同事务的中间状态通知。源码宿主 IPC 就绪中位数由 8.947 秒降至 1.997 秒，原 15 秒期限不变；此数据只代表源码加载器，不是生产 IDE 全页面启动时间。

六轮均通过真实函数补全、类型诊断、搜索、Quick Open、终端、五人编辑保存、撤销重做、离线重连、刷新、在线撤权、独立环境隔离，以及活跃浏览器下停止 Server 和进程回收。90 次实际页面检查无非预期浏览器错误，样本中无 OOM；外层测试容器、卷、网络和 context 已确认释放。最终框架全量回归 4,793 项通过、57 项既有跳过，两套 Linux 镜像及本地完整构建通过。

测量夹具是 100 个小型辅助 TypeScript 文件及协同、语言功能文件，每台开发机限制 4 CPU / 4 GiB，使用每连接 Node watcher，没有 AI 请求。内存采样在操作完成并预热 30 秒后进行，不含 Chromium、固定控制面、OpenSandbox 守护进程和 Docker VM 开销。主机采样负载为 10.7–121.8，旁路观察存在换页；结果尚不构成安静主机、默认 2 GiB、大型仓库或五人持续重负载的稳定容量保证。

完整分轮内存、CPU、真实页面耗时、复现方法及失败记录见 [启动与五人内存对照](docs/RUNTIME-PERFORMANCE-20261025.md)，精确结果和证据索引摘要见 [验收 JSON](docs/runtime-memory-acceptance-20261025.json)。[10 月 2 日局部内存探针](docs/DEPENDENCIES-AND-MEMORY.md#可复现的局部内存对照)与 [10 月 3 日未完成的验收](docs/COLLABORATION.md#2026-10-03-收尾结果)继续保留，不能与本轮直接相减。

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

托管工作区默认启用 Node/Yjs 协同。所有者可邀请四名已登录账户共同编辑，成员使用同源认证入口；移除成员立即撤销其会话与连接。邀请同时授予当前开发机的终端能力，只用于可信协作。权限、五人内存测量与适用边界见 [协同说明](docs/COLLABORATION.md)。

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

## 项目结构

`application/` 是工作台产品，`client/` 和 `server/` 是独立 IDE 的产品入口，`packages/` 保留 OpenSumi 框架与扩展 API，`configs/` 与 `scripts/` 提供统一工具配置和执行入口，`tools/`、`test/` 提供开发与验收支持。

工作台内部按共享契约、浏览器界面、业务模块、运行驱动和 HTTP 传输组织。详细文件树见 [产品目录](application/README.md)，依赖方向、删除依据及验证边界见 [架构说明](docs/architecture/product-structure.md)。`pnpm check:product` 会检查跨层导入、循环依赖、缺失文件和产品源码的中文注释；它已接入测试入口和 CI。

自维护工作区通过 `pnpm check:versions` 检查依赖范围一致性。10 月 2 日更新 41 种依赖，并修复 RPC 取消监听、过期认证状态、代理发送缓冲和大日志读取的内存问题；版本选择、局部内存对照与实际验证边界见 [依赖与内存维护记录](docs/DEPENDENCIES-AND-MEMORY.md)。

## Docker 与沙箱验收

```sh
docker build -t opensumi-webide-node:dev .
docker build -f application/runtime/Dockerfile --build-arg OPENSUMI_BASE=opensumi-webide-node:dev -t opensumi-webide-workspace:dev .
WEBIDE_ACCEPTANCE_IMAGE=opensumi-webide-workspace:dev bash scripts/run-local-sandbox-acceptance.sh
```

验收脚本在私有 DinD 中启动官方 OpenSandbox；测试账户、沙箱与卷全部隔离，并在退出时清理该测试环境。运行前需安装仓库依赖并启用 Docker，详情和版本边界见 [运行说明](docs/RUNNING.md)。

## 共享 Node watcher

默认仍按连接启动 watcher；实验模式需要显式设置：

```sh
OPENSUMI_NODE_WATCHER_MODE=shared pnpm start
```

共享仅限同一个 IDE Server 的多个连接，独立工作区 Server 不会跨进程共享。共享宿主崩溃时会通知客户端重扫并重建存活租约，停止时取消恢复。macOS 的 Parcel/默认后端及 Linux Parcel 五连接崩溃探针、活跃浏览器下的 Server 退出检查通过；共享 watcher 对整棵 IDE 的内存和延迟改善仍未验收。上面的五人对照使用每连接 watcher，不代表共享 watcher 模式的整树收益。详见 [共享 watcher 说明](docs/architecture/shared-node-watcher.md)及其中保留的原项目实验记录。

## 来源与许可证

本仓库保留 OpenSumi 的 Git 历史和包命名空间，初始上游基线为 `9a7057aec`。`origin` 指向 `advance-hub/webide`，OpenSumi 远程保留为 `upstream`。

项目沿用 [MIT License](LICENSE)，第三方声明见 [NOTICE.md](NOTICE.md)。感谢 OpenSumi 及相关扩展与依赖的维护者。
