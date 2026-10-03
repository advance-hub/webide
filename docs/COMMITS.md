# 本地提交记录

本次整理保留 OpenSumi 的原始历史，从上游基线 `9a7057aec` 开始，按变更用途拆分提交。分支为 `main`，`origin` 已配置为 `https://github.com/advance-hub/webide.git`，原 OpenSumi 远程保留为 `upstream`。

按用户选择，本轮只完成本地提交，未推送到 GitHub。首次推送成功后再建立 `origin/main` 的跟踪关系。

## 实现与工程提交

| 提交        | 主题                                                              |
| ----------- | ----------------------------------------------------------------- |
| `b4acaf9c6` | chore(toolchain): 固定 Node 24 与 pnpm 并迁移 TypeScript 7 工具链 |
| `59725f8f6` | refactor(core): 整理核心包入口与运行时依赖边界                    |
| `839d61279` | refactor(ui): 适配组件布局与编辑器基础设施                        |
| `bec729547` | refactor(ide): 迁移编辑文件终端与工作区功能                       |
| `9674bac05` | refactor(extensions): 整合扩展宿主调试与会话管理                  |
| `d4cad2eb5` | fix(hooks): 串行执行格式化与 ESLint 避免并发改写暂存文件          |
| `3c2666217` | refactor(startup): 整合产品组合与 AI 工作台模块                   |
| `160a09814` | feat(build): 增加产物校验与统一启动编排                           |
| `75f15705c` | feat(runtime): 接入 Rspack 产品入口与 Node IDE 服务               |
| `dbb64def2` | feat(plugins): 完善内置扩展下载校验与扫描索引                     |
| `2a552af54` | feat(workspace): 迁移 Git Maven 与开发机辅助工具                  |
| `7e72e2bf9` | feat(workbench): 实现 Koa 工作台控制面与沙箱驱动                  |
| `5a057f12c` | feat(workbench-ui): 接入项目工作区与开发机管理界面                |
| `e45b63556` | feat(watcher): 移植服务级共享 Node watcher 实验                   |
| `a610f29b4` | chore(scripts): 统一工程维护与诊断脚本入口                        |
| `f13eb9607` | fix(scripts): 移除重复的工作台测试命令定义                        |

本页、README、运行配置、迁移进度和 watcher 实验说明在最后的 `docs(webide): 补齐运行配置迁移进度与实验验收记录` 提交中一起保存。可以查看全部 17 次提交的完整说明：

```sh
git log --reverse --format=fuller 9a7057aec..HEAD
```

## 验证与边界

所有提交均执行仓库的格式化、ESLint 和 commitlint 钩子，没有跳过钩子。每批暂存前检查文件范围，并执行 `git diff --cached --check`。

Prettier 和 ESLint 原先会并发改写相同文件，AI 模块批次曾出现临时 JSX 解析错误；单独检查源文件正常。独立修复提交将两个写入任务串行执行，随后该批次通过。

具体构建与测试结果见 [迁移状态](MIGRATION.md)。本地配置、数据库、凭据、插件下载缓存和原始性能采样不进入提交。共享 watcher 保留实验开关，完整平台的剩余迁移和验收事项继续记录在迁移状态中。

## 2026-10-02 Node 控制面补齐

本轮删除 Go 运行引擎，补齐资源、Git 和机器控制面，并执行本机 Docker/OpenSandbox 及上游回归。沿用原历史与 `main`，只完成本地提交，未推送。

| 提交        | 主题                                                        |
| ----------- | ----------------------------------------------------------- |
| `1a8fb74cf` | refactor(runtime): 移除 Go 引擎并统一 Node 服务退出链路     |
| `afdf2cfeb` | fix(watcher): 崩溃后重建共享宿主并恢复存活订阅              |
| `57409f7cb` | feat(runtime): 实现开发机数据维护身份恢复与真实卷释放       |
| `80892527f` | feat(workbench): 接通开发资源 Git 发布与开发机维护控制面    |
| `ee8ee4474` | build(docker): 提供 Node 24 镜像与隔离 OpenSandbox 验收入口 |
| `d3954d89c` | test(ide): 修复上游回归接口与终端夹具资源回收               |
| `542af435a` | test(sandbox): 验证真实 IDE 页面与 WebSocket 代理通道       |
| `2e53f5205` | docs(webide): 沉淀 Node 控制面契约与实际验收边界            |

本表在最后的 `docs(commits): 登记 Node 控制面分批提交与验收结果` 提交中保存；该记录提交自身的哈希以 `git log` 为准。本轮共 9 次提交。

```sh
git log --reverse --format=fuller 0789312e1..HEAD
```

Node 回归 140 套件/1,481 项测试、jsdom 回归 350 套件/3,264 项测试通过；终端读流修复后 Jest 正常退出。控制面 21 项、辅助工具 29 项、工程契约 62 项与 Server 诊断 26 项通过。最终 Node 镜像在专属 DinD 内通过双账户、HTTP/WS、加密备份恢复、升级保留 PVC 和实际删除等六阶段验收，测试容器、context、网络和数据卷已清理。详细计数和未验收范围见 [迁移状态](MIGRATION.md)和 [可移植摘要](node-control-plane-acceptance-20261002.json)。

每次提交前检查明确的暂存范围和 `git diff --cached --check`，格式化、ESLint 与 commitlint 钩子均执行。运行数据和凭据只保留在忽略目录，本轮没有跳过检查、改写上游历史或创建外部 MR/PR。

## 2026-10-02 产品结构与工程规范

本轮从 `7ffc64a7c` 开始，拆分工作台的共享契约、浏览器状态、业务模块、运行驱动和 HTTP 传输，统一生产打包入口，移除已确认失效的配置与重复输入解析，并增加模块依赖和中文说明性注释检查。

| 提交        | 主题                                                       |
| ----------- | ---------------------------------------------------------- |
| `32fe56a94` | refactor(workbench): 拆分产品职责并统一源码与生产运行入口  |
| `f55cb2ae8` | chore(engineering): 统一中文注释并更新有效调试入口         |
| `b9e109cd7` | test(sandbox): 复用已缓存镜像并隔离每轮验收证据            |
| `e30342cab` | docs(architecture): 明确产品模块边界并保存本轮完整验收结果 |

本表由最后的 `docs(commits): 登记产品结构重构与分批验收提交` 保存，该记录提交自身的哈希以 `git log` 为准。本轮共 5 次本地提交，没有推送。

```sh
git log --reverse --format=fuller 7ffc64a7c..HEAD
```

结构检查覆盖 112 个产品源码文件；工作台 25 项、辅助工具 29 项、工程脚本 67 项、Server 诊断 26 项及上游 4,745 项测试通过，上游另有 57 项跳过。完整构建与产物摘要检查通过，实际 Docker/OpenSandbox 六阶段验收通过并回收测试资源。注释调整的 34 个源码文件经语法树比较没有结构变化。

详细分层、兼容约束和删除依据见 [架构说明](architecture/product-structure.md)，本轮计数、镜像与未验收范围见 [可移植摘要](architecture/product-structure-acceptance-20261002.json)。产品和维护入口使用中文说明性注释，上游既有 API 说明与版权原文保留。原始日志、失败尝试和 SHA-256 索引留在忽略目录 `output/refactor/`。

## 2026-10-02 依赖维护与内存修复

本轮从 `7f8cc66eb` 开始，更新 41 种依赖并统一工作区版本契约，修复控制面的缓存、代理缓冲与有限读取问题，以及 RPC 调用完成后未释放的取消监听。保留 Node 24、原生 TypeScript 7、OpenSumi 公开 API 和数据格式；Go 后端保持删除。

| 提交        | 主题                                                   |
| ----------- | ------------------------------------------------------ |
| `6fe4d0717` | chore(deps): 更新 41 种依赖并统一工作区版本契约        |
| `0f8725dc3` | fix(workbench): 限制认证缓存与代理缓冲并避免保留大日志 |
| `a54508265` | fix(rpc): 释放已结束请求的调用方取消监听               |
| `7633cf7fd` | docs(maintenance): 保存依赖策略与内存修复验收证据      |

本表由最后的 `docs(commits): 登记依赖更新与内存修复的分批提交` 保存，该记录提交自身的哈希以 `git log` 为准。本轮共 5 次本地提交，未推送。

```sh
git log --reverse --format=fuller 7f8cc66eb..HEAD
```

最终上游 Node 1,485 项、jsdom 3,268 项，共 4,753 项通过，另有 57 项原有跳过项。工作台 31 项、工程脚本 69 项、运行辅助工具 29 项、Server 诊断 26 项，以及类型、完整构建与产物摘要检查通过。Linux amd64 最终镜像通过编译入口的 HTTP/静态资源/认证/退出检查及隔离 OpenSandbox 六阶段验收，专属测试环境已清理，原有服务保留。

三轮受控保留堆中位数：过期票据约 `13.003 → 0.214 MiB`，64 MiB 日志尾部约 `64.015 → 0.018 MiB`。这只比较同一依赖环境中的指定函数，不代表整体 IDE、语言服务或 RSS 同比例下降。一次原生 watcher 空文件新建事件缺失的失败仍保留，独立套件和最终全量重跑通过，原因未确定。

版本选择、复现步骤和大版本迁移边界见 [维护记录](DEPENDENCIES-AND-MEMORY.md)，完整计数、镜像 ID、测量与证据索引摘要见 [可移植验收结果](dependency-memory-acceptance-20261002.json)。所有提交执行格式化、ESLint 与 commitlint 钩子，每批暂存均检查明确文件范围及 `git diff --cached --check`。原始日志、采样、失败尝试和 SHA-256 索引保存在忽略目录 `output/runtime-profiles/dependency-memory-20261002/`，不进入 Git。

## 2026-10-02 至 03 五人协同与真实运行诊断

本轮从 `98476b6ac` 开始，接通托管工作区的五账户邀请、同源协同和成员撤销，修复扩展宿主换代、通道确认重试与终端就绪链路，限制 SDK 传输和诊断记录的持有数量。空闲 IDE 按需启动 AI Agent。

| 提交        | 主题                                                        |
| ----------- | ----------------------------------------------------------- |
| `239917c1e` | feat(collaboration): 复用认证入口并回收连接持有的协同文档   |
| `fafade9b1` | feat(runtime): 为托管工作区启用同源协同与五连接容量         |
| `87a8f46a4` | feat(workbench): 完成五人邀请权限与在线成员即时撤销         |
| `ac110d0df` | fix(collaboration): 让沙箱代理保留托管协同内部凭据          |
| `c5e331323` | perf(ai): 默认按需启动 Agent 并避免空闲连接预加载历史       |
| `77a5e0d4e` | perf(proxy): 合并运行环境查询并在等待后重新检查授权         |
| `f6d4ba531` | test(sandbox): 提供五人认证协同与双场景进程树验收入口       |
| `b0e51f181` | perf(sandbox): 复用有界 SDK 传输并在租约释放后回收          |
| `8fff862c9` | test(collaboration): 核对验收运行前后源码并保留清理失败     |
| `7b30dd7a6` | test(terminal): 通过真实剪贴板输入命令并保留失败回执        |
| `337b045fd` | fix(extension): 等待退役进程释放名额再接纳新连接            |
| `ab1d50dd5` | fix(connection): 让通道打开重试幂等并保留刷新握手诊断       |
| `21760492d` | test(collaboration): 保存握手阻断页面的完整诊断             |
| `5b406f93a` | fix(terminal): 标记远端终端就绪并取消退役视图的等待         |
| `e2c2b8bbf` | docs(collaboration): 明确五人权限运行边界与真实验收入口     |
| `222794b40` | test(terminal): 等待就绪时保持终端面板展开                  |
| `ba5670f3b` | fix(proxy): 保留合法关闭码并记录有界连接结束诊断            |
| `1994a7375` | test(collaboration): 保存只读传输时序并校验全部验收辅助文件 |
| `319c96eb2` | test(editor): 打开文件前显式激活资源管理器                  |
| `9d0e74b31` | test(runtime): 保留采样就绪失败与容器内核对结果             |
| `2206c029c` | fix(editor): 随产品交付同源 Monaco Worker                   |
| `412548f2f` | fix(startup): 对齐轻量示例的文件提供者与保存状态契约        |
| `5e22ccc0d` | fix(build): 保留预编译 Worker 的原始字节                    |
| `a118d1465` | docs(collaboration): 保存五人实测结果与未完成验收边界       |

以上均为本地提交，格式化、ESLint 与 commitlint 钩子正常执行。真实浏览器失败尝试继续保留，不用修改超时、减少扩展或跳过样本将失败转为通过。诊断采集补丁曾在提交前消失，重新明确暂存后单独保存为 `21760492d`；源码回写来源尚未定位。

`2206c029c` 的提交说明曾提前将完整客户端类型检查记为通过；实际检查发现轻量示例的 9 处历史接口错误。后续 `412548f2f` 保留完整检查范围，修复提供者和保存枚举契约后重新检查通过，提交说明也保存了更正。

最终保留 120 / 180 份计划样本。共享工作区三轮、活跃连接下停止 Server 和在线撤权完成；独立开发机完成一轮，第二轮 Dave 的页面标题就绪超时，完整验收仍为失败。共享三轮 P95 RSS 中位数约 4.26 GiB、独立单轮合计约 5.08 GiB，均只作诊断。最新 Node 全量 1495 项通过、1 项扩展宿主就绪超时，不能宣称全量通过。

验收前后及收尾源码摘要一致，原回写来源仍未定位。工作区清理无报告错误；收尾 Docker 未运行，无法再次核对外层资源删除。原始证据索引覆盖 631 个文件，索引摘要及明确的 `pass: false` 保存在 [可移植结果](collaboration-acceptance-20261003.json)。本节登记上述 24 个实现和结果提交；本文件的独立登记提交通过下面的 Git 命令查询。

```sh
git log --reverse --format=fuller 98476b6ac..HEAD
```

运行边界、验收入口和实际容量结论见 [五人协同说明](COLLABORATION.md)。原始日志、浏览器截图、进程采样、失败记录和源码监测保存在忽略目录 `output/runtime-profiles/collaboration-20261002/`，不进入 Git。
