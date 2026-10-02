# Node 重建版迁移与验收状态

当前保留 OpenSumi 上游 `9a7057aec548b11598b8ec5f39a5538546b218e2` 的历史、MIT 许可证与扩展 API。2026-10-02 在迁移基线 `0789312e1` 上补齐下列 Node 控制面能力；原本地项目 `32dff6c` 只作为只读语义参考，未复制 Go 后端。

下表保存首次控制面补齐的执行结果。后续产品结构调整见 [结构验收摘要](architecture/product-structure-acceptance-20261002.json)，41 种依赖更新与内存修复见 [维护记录](DEPENDENCIES-AND-MEMORY.md)和 [本轮验收摘要](dependency-memory-acceptance-20261002.json)；不同批次的测试计数和性能边界分别保留。

## 已实现

| 范围 | 当前行为 |
| --- | --- |
| 运行引擎 | 删除 Go watcher/search、Gateway、proto、RPC 依赖、诊断与构建入口，移除 Go 工具和两个 Go 插件；Node 搜索/Quick Open/watch 保留 |
| 开发资源 | 7 类账户配置、协议/认证探测、COS 前缀列表及受限文本、个人编辑器连接同步与共享工作区撤销 |
| Git | 目标地址限定、IDE 租约凭据桥、已提交 bundle 发布、固定基线校验、正常推送、GitHub/GitLab/Gitee 幂等 MR/PR |
| 开发机 | 加密备份、事务恢复与中断收尾、策略、空闲停止、自动备份、资源指标、受管缓存清理 |
| 生命周期 | 实际本机构建/沙箱镜像替换、PVC 保留、身份核验认领孤儿、共享 OS 身份的非演示部署拒绝 |
| 卷删除 | Docker 受管卷实际删除；Kubernetes namespace、UID/resourceVersion 前置条件、Pod 分页挂载检查和删除完成确认 |
| watcher | 默认按连接；实验共享池增加崩溃重扫、存活租约重订阅、有限恢复尝试和停止取消 |
| Server 退出 | HTTP/WS 入场关闭、连接/贡献者/根注入器四阶段、CLI 成功关闭后主进程退出 |
| 工程 | Node 24.16.0 / pnpm 12.8.1 / TS 7.0.2 / Rspack 2.2.8；Node 基础/沙箱镜像；8 个旧工作流迁移 |
| 上游回归 | 保留架构检查，修正旧私有 mock 引用和 node-pty 测试读流回收；全量 Node/jsdom 回归入口 |

原有项目/工作区、加密 SQLite、一次性 IDE 入口、HTTP/WS 代理、Maven 队列及工作台界面继续使用。Maven 元数据保留 Python 辅助程序，Java 工具为现有项目服务；Node-only 指运行引擎和控制面，不代表 IDE 只支持 JavaScript。

## 本次执行证据

| 检查 | 已观察结果 |
| --- | --- |
| 完整构建 | 60 个 TS 包项目、宿主/Worker、Server、IDE 客户端和工作台构建通过 |
| 上游 Node | 140 套件、1,481 项测试通过；4 套件/29 测试跳过，6 个快照 |
| 上游 jsdom | 350 套件、3,264 项测试通过；2 套件/28 测试跳过，7 个快照；终端读流清理后正常退出 |
| 工程契约 | 62 项 runtime-scripts 测试与公开 API 兼容类型检查通过 |
| 控制面 | 21 项测试通过：实际磁盘/Git/Node IDE、协议夹具、维护故障恢复、SDK 和 Kubernetes 删除契约 |
| 运行辅助工具 | 29 项 Node 测试通过，包括归档、恢复日志、路径约束、缓存与编辑器配置 |
| 孤儿进程 | 单独真实进程测试通过：新 driver 认领、伪造身份拒绝、活跃 WS 退出、脏文件保留 |
| watcher 崩溃 | macOS Parcel、macOS 默认、Linux Parcel：各 5 连接，事件/路径隔离、已释放租约不复活、重订阅与回收通过 |
| 活跃浏览器退出 | 浏览器终端仍运行时先停 Server；四阶段完成，采样的主进程、watcher、扩展宿主、语言服务、shell、sleep 共 6 个进程均退出，观察耗时 204 ms |
| Docker/OpenSandbox | 实际官方 SDK/Server/execd，两个账户容器与文件隔离；真实 IDE HTTP/WS 代理、加密备份恢复、升级保留 PVC、容器与 Docker 卷删除共 6 阶段通过 |
| 插件与静态检查 | macOS ARM64、Linux x64 的 70 个配置插件校验；工作台/脚本类型、修改文件 ESLint、YAML 与文档检查 |

原始凭据索引、进程树、磁盘步骤、容器日志与结果在本机 `output/runtime-profiles/`，不提交。可移植结果索引见 [本次验收摘要](node-control-plane-acceptance-20261002.json)，控制面契约与失败处理见 [设计文档](NODE-CONTROL-PLANE.md)。

构建仍有 13 个已知警告：IDE CSS 顺序 7 个、组件大小/`__filename` 3 个、Monaco Worker 大小/性能建议 3 个。Jest 的现有跳过用例不视为通过。以上没有进行原实验九轮浏览器性能对照、长期稳定性或生产容量验收。

## 未执行或保留限制

- Windows 原生产品尚未运行；已配置 Windows/macOS/Linux CI 矩阵，未推送，所以远端工作流未执行。Linux 已在本机 Docker 的 x64 模拟环境执行真实 IDE/OpenSandbox HTTP/WS 与 watcher 验收，完整 Linux 浏览器交互矩阵、其他发行版与 ARM 原生平台尚未覆盖。
- Kubernetes 已实现删除后端，协议测试覆盖第二页 Pod、UID 变化、异步完成与幂等；没有真实 Kubernetes 集群，不能宣称真实 PVC 删除验收通过。
- GitHub/GitLab/Gitee 使用真实 Git HTTP 服务和 API 夹具验证，未使用外部账户创建实际 MR/PR。资源探测的协议夹具与 COS SDK 测试未替代真实云 COS、MySQL 等服务的专项验收。
- `retained` 存储模式禁止直接镜像升级，须先备份并迁移到 PVC。当前升级验收镜像仅改变指纹，跨发布版本升级仍需发布时验收。
- 独立开发服务自动启动、独立预览域名、日志与停止的完整联动不在本轮补齐列表，仍需后续产品验收。
- 共享 watcher 保持实验开关；独立 Server 不共享，事件间隙靠 rescan 通知补偿，不能保证崩溃期间每个瞬时事件都重放。连续恢复失败有上限，反复成功后再崩溃的频率限制仍需长期稳定性验证。

## 兼容与提交

历史 Go 性能 JSON/Markdown 作为测量来源保留，并标记当前已移除该引擎。现有目录、凭据密钥、Git 基线与工作区脏文件保留；备份恢复会显式替换目标机器的数据，不隐式降级为新建空环境。切换到 Node-only 后需完整构建并重启工作台与 IDE，旧 Go 环境变量/私有导出不再支持。

本轮按领域拆分中文提交，仅保存在本地，记录见 [COMMITS.md](COMMITS.md)。`origin` 指向 `advance-hub/webide`，`upstream` 指向 `opensumi/core`；没有重新初始化或改写上游历史。
