# Node 控制面补齐与 Go 引擎移除（2026-10-02）

> 评审目标：通过账户领域服务、资源互斥与统一 RuntimeDriver 实现资源配置、Git 发布和开发机维护；保持 Git 基线、脏文件与账户边界，移除 Go 运行引擎，并以实际进程与隔离 Docker 验收界定交付范围。

## 1. 现状、证据与结论

本轮实现基于重建版 `0789312e1`，保留上游 `9a7057aec548b11598b8ec5f39a5538546b218e2` 历史。原本地项目 `32dff6c` 的工作台语义只读参考。新增代码已落地，不是待实现计划；验收状态与环境边界分别记录。

| 原缺口 | 实现证据 | 可观察结果 |
| --- | --- | --- |
| 资源页面缺少后端 | `DevelopmentResources` 与已有编辑器辅助工具 | 7 类配置、认证探测、COS 列表/文本和连接同步 |
| IDE 无受限 Git 凭据与发布 | `GitControl`、`Repositories.credentialTarget` | 租约桥只到固定仓库；提交 bundle 正常推送并创建/复用 MR/PR |
| 机器维护无一致流程 | `Machines`、`Jobs.run` 和机器归档/恢复辅助工具 | 停止、加密归档、恢复及中断收尾在机器/工作区锁内执行 |
| 升级仅 restart、孤儿归属不明 | 两种 RuntimeDriver 与私有身份接口 | 实际构建/容器替换；核验身份后认领或停止孤儿 |
| 同 OS 身份、多账户卷释放缺失 | `loadConfig`、`SandboxRuntime.release`、`KubernetesVolumes` | 非演示 local 拒绝；隔离容器/卷；真实删除后才删状态 |
| Go 可注入且构建保留旧路径 | Node 运行契约、DI、镜像与工作流 | Go 实现/协议/依赖/工具/插件退出，Node 回归保留 |
| 崩溃订阅与活跃连接退出未验证 | shared watcher 重建、四阶段关闭与实际探针 | 存活租约恢复、已释放租约不复活；采样进程全部退出 |

完整回归有现存跳过用例；Windows、真实 Kubernetes、外部 Git 与云资源未执行生产环境验收。共享 watcher 仍为显式实验模式，没有整树性能改善承诺。

## 2. 目标与不变项

1. SQLite 的账户/机器/项目所有权是状态真相源；公开视图不返回资源密码、Git PAT、桥接令牌或备份密钥。修改或删除前再次核验所有权。
2. IDE 以固定 Git 基线准备工作树，普通启停、认领和升级保留未提交文件。发布仅包含用户已提交对象，不自动提交、覆盖分支或 force push。
3. 机器重操作锁定机器、工作区及 Maven 资源。失败后保存阶段与 `needsRecovery`，其他修改返回冲突，不将恢复失败当成空环境启动。
4. 跨账户运行必须经过 sandbox；本机 driver 仅用于回环单用户演示。原始 PID 不能单独证明归属。
5. 仅受管且未挂载的卷可删除；等待后端确认对象消失后才删除机器元数据。`external` 返回明确冲突，不模拟成功。
6. 共享池保留公开逻辑 ID，原生订阅由后端/URI/规则/递归/轮询策略决定；退租和停止取消恢复，旧关联 ID 不分发给新租约。
7. 历史上游 API、许可与实验来源保留；Go 私有运行契约明确撤销。Java/Python 等项目工具不属于被移除的 Go IDE 引擎。

采用 Node 领域服务复用现有 Koa/Store/Jobs 与辅助工具，避免控制面与运行容器维护两套状态机。机器级备份选择短暂停止以获得一致文件快照，代价是任务期间 IDE 不可用；请求显示任务状态，失败有显式恢复入口。

## 3. 接口与数据所有权

工作台页面通过既有账户会话访问控制面；路由将 owner 传入领域服务。以下是实际路由和关键输入，错误文本脱敏。

| 接口 | 输入/返回与职责 |
| --- | --- |
| `GET /api/development-resources` | 返回 7 项公开配置与 configured 标记，无凭据 |
| `GET/POST /api/development-resources/:id` | 读取/保存账户配置；凭据读取 no-store，非演示要求 HTTPS |
| `POST /api/development-resources/:id/probe` | 返回 ready/failed、脱敏 detail、成功时延；验证协议/认证 |
| `GET /api/development-resources/cos/objects` | prefix、marker；限定配置前缀并分页读取 |
| `GET /api/development-resources/cos/text` | key；最多 64 KiB UTF-8，无写接口 |
| `POST /api/workspaces/:id/editor-connections` | 同步个人 MySQL/Redis 或撤销成员工作区个人凭据 |
| `POST /api/connections/gitlab` | 保留旧接口路径，保存 provider、URL、token、可选 account 并验证代码源用户 |
| `POST /api/workspaces/:id/git` | 现有 Git 辅助动作，在机器/工作区锁内执行 |
| `POST /api/workspaces/:id/publish` | targetBranch、可选 title；验证提交并发布、创建/复用 MR/PR |
| `GET /api/machine/backups` | 仅目标账户机器的备份列表与任务公开状态 |
| `POST /api/machine/backups` | action=backup/restore/recover/delete；restore/delete 使用 backupId |
| `POST /api/machine/tools` | inspect/clean-cache 等辅助动作；policy-save 保存 idleMinutes/autoBackupHours |
| `POST /api/workspaces/:id/update-runtime` | 返回 202，实际执行整台机器的升级任务 |
| `POST /api/machine/release` | 无工作区且资源可用时释放容器/卷后删除机器记录 |
| `GET /git/:lease.git/info/refs` 与 `POST` upload/receive-pack | 独立 Basic 租约认证的 Git smart HTTP，只代理存储的仓库 |
| `GET /runtime/identity` 与 `POST /runtime/shutdown` | IDE 私有 Bearer 接口；不使用浏览器 session，返回已核验身份/202 |

`ResourceProfile` 的 endpoint/database/username/options 和 COS bucket/region/prefix 与秘密一起在账户加密凭据表持久化；列表由 publicProfile 转换。改地址不沿用旧密码。MySQL/Redis 下发为用户可编辑的副本，辅助工具只修改自身标记项，不覆盖手工配置。

`MachinePolicy` 默认 idleMinutes=120、autoBackupHours=0；0 关闭，对应上限 10080 分钟/168 小时。`MachineJob` 持久化 action/status/phase/resume/previous/needsRecovery，公开视图省略内部工作区快照。`Backup` 记录机器、owner、SHA-256、大小、时间和工作区快照；AES key/IV/tag 存于加密凭据表，文件单独保存 `.enc`。

机器和项目限定的 `GitLease` 与源 PAT 分离；机器/项目被删除后桥接失败，配置更新使用最新源凭据。已推送 SHA 与 MR/PR 创建分阶段持久化，防止失败重试遗漏已完成动作。

## 4. 资源探测与编辑器同步

HTTP 使用原生 client，6 秒超时、1 MiB 上限、不继承环境代理、不转发重定向凭据。Redis 发 AUTH/SELECT/PING；MySQL 使用 mysql2 登录与 ping；RocketMQ 验证 NameServer 帧与关联 opaque；Nacos 验证登录及服务列表；Elasticsearch/Middleware 验证认证后的读取。服务类型决定能证明的范围，例如 NameServer 通过不能证明 Broker 消息权限。

COS 使用官方 SDK，列表限制配置前缀与 100 个对象，文本请求 Range 并在服务忽略 Range 时仍限制输出，拒绝二进制/非法 UTF-8/越界 key。探测失败返回统一说明；具体密钥和上游响应不进入浏览器错误。

工作区准备、Git 配置和 IDE 启动完成后同步编辑器连接；同步失败保存 startup.editorConnections.error，但 IDE 可就绪，用户可单独重试。共享成员工作区只撤销个人连接，避免通过多人 IDE 扩散个人资源秘密。

## 5. Git 凭据桥与提交发布

安装 Git 配置时创建机器/项目租约，将私有令牌写入权限受限文件，由 Git credential helper 读取。PAT 留在控制面。bridge 认证采用固定长度摘要比较，检查 machine/project/owner；目标只能来自 project.url，且 origin/路径前缀必须匹配代码源。浏览器 Authorization、Cookie 不转发，源重定向不跟随，流量最多 512 MiB、10 分钟。

发布锁定机器/工作区，导出已提交分支的 Git bundle，验证目标分支、HEAD、工作区基线及提交对象，然后通过受管仓库正常 push。源端非快进或认证失败返回失败，IDE 的脏文件不受影响。

push 成功先保存 publishedSha，再按 provider 查已有开放 MR/PR；不存在才创建，创建冲突后再查。GitHub、GitLab、Gitee 使用各自 API 参数。MR/PR 阶段失败可重试；正常 push 的源端分支冲突仍需用户在 IDE 处理，幂等流程不绕过 Git 一致性约束。

## 6. 开发机维护与中断恢复

备份/恢复/升级使用 `Jobs.enqueue` 的多资源互斥，轻量修改使用 `Jobs.run`；同机 Maven、工作区生命周期及发布任务不能与维护重叠。只在任务结束后释放全部资源键。

备份流程：保存原 ready 工作区 → 停 IDE → 生成机器 tar → 验证条目/摘要 → 流式 AES-256-GCM 加密 → 保存文件和凭据索引 → 恢复原 ready 工作区。归档不含日志、socket、Git 桥租约/IDE 身份文件、缓存；最多 5 GiB、100000 条目，允许归档内的相对链接，拒绝绝对链接、越界和恢复保留路径。失败删除半成品。

恢复流程：核验备份 owner/machine/项目 → 私有暂存目录解密并核验摘要 → 写持久恢复日志并原子替换目录 → SQLite 事务替换工作区快照 → commit 文件事务 → 重启之前 ready 的工作区。文件和元数据中断阶段不同，恢复任务分别 rollback 或完成 commit；非空机器缺少日志时拒绝自动推断。加密文件、SQLite 和原密钥应一起保留，备份不是独立跨控制面导入格式。

控制面重启将 running job 标记 failed+needsRecovery。失败后的 recover 复用持久阶段与原 resume 列表，不重新检出基线。文件操作完成但 IDE 重启失败显示部分失败，文件结果保留，可单独启动。

维护器每分钟检查，存在浏览器连接不回收；达到空闲阈值且 IDE 健康才停止。自动备份仅对全部停止的工作区执行，失败尝试每小时限一次，保留最近 5 份自动备份。clean-cache 仅处理受管目录，并检查 Maven 进程；无法可靠确认进程时拒绝清理。

## 7. RuntimeDriver、身份与卷生命周期

`LocalRuntime` 使用实际 process.execPath 启动编译后的 Node Server。0600 日志记录 PID、令牌、指纹；认领必须通过私有身份 API，同时匹配工作区 ID、真实目录与 PID。日志伪造或进程不匹配时拒绝信号，不把任意端口进程视为 IDE。认领后通过认证 shutdown 停止，正常子进程按已知进程组回收。

本机升级运行完整构建并重新计算产物指纹；sandbox 升级保存目标/旧镜像，停止旧容器并使用同一 PVC 创建新容器。成功观察新容器 ID、就绪身份和指纹，失败保持可恢复状态，recover 重试目标镜像；没有跨镜像自动回滚保证。retained 模式返回 409，须先备份并迁移 PVC。

Docker 删除只接受受管 32 位机器卷名，拒绝任何仍挂载的容器，不使用 force，删除后再次确认不存在。Kubernetes 使用 HTTPS、namespace 范围 token/CA，逐页检查 Pod 挂载，保存 UID/resourceVersion 条件删除，等待 404；对象被替换或删除未完成时保留状态。后端权限最小集为 PVC get/delete 与 Pod list。external 明确返回 409，包括容器已经消失的场景。

非演示 local 在启动配置校验即被拒绝。sandbox 通过机器/账户标签认领受管容器，账户摘要截取 32 位满足标签限制。SDK 的文件权限传八进制数字字符串对应的数值 700/600，与本机 fs 的 0o700/0o600 分开处理，实际 Docker 验收覆盖该协议差异。

## 8. watcher 恢复与 Server 退出

共享池保留订阅 recipe。宿主意外退出先通知存活连接 rescan，再按后端串行建立新宿主并重注册活跃条目；内部关联 ID 更新，公开逻辑 ID 不变，旧事件被丢弃。恢复启动有 15 秒取消边界，最多 3 次失败尝试；取消后的迟到注册立即释放。退租/全局停止使恢复终止，释放异常纳入有限重试。

崩溃通知证明需要重扫，不能重放宕机期间每个短暂事件。恢复成功后反复崩溃的长期频率限制尚未专项验证。默认 per-client 不改变；shared 仍需要显式开关。

关闭协调器先关闭 HTTP/WS 入场，再顺序执行 server、connections、contributions、injector。任务返回稳定幂等 Promise，同步 stop 错误也进入报告；主 CLI 在四阶段成功、输出刷新后退出。库调用默认不退出宿主进程。真实探针在浏览器、终端、扩展和 watcher 存活时先停止 Server，检查主进程与全部采样子进程；只有报告完成不足以证明退出。

## 9. 构建、迁移与运行策略

根 Dockerfile 在 Node 24 上 frozen install、编译全部框架/工作台并安装 70 个插件；workspace 镜像提供 Java/Maven 和 Node 辅助工具，不安装 Go。旧 CI 迁移 Node 24/pnpm，平台矩阵包括 Windows/macOS/Linux；回归保留架构门禁，手动沙箱工作流使用专属 DinD。镜像工作流只产出 artifact，不自动发布 npm/仓库镜像。

升级前保留原数据库、密钥和机器文件，停工作台及 IDE、完成新构建后重启。Go 环境变量、proto 和私有 exports 已撤销；历史 Go 性能记录保留来源声明，不是当前运行入口。若需回退代码，使用前一个版本和其镜像，在停止服务、核验文件与状态兼容后恢复；不会自动回退到 Go。

镜像构建和 Linux 验收目前在 ARM64 macOS 上运行 x64 Docker 模拟。生产网关、真实 Kubernetes、外部代码源/云资源和 Windows 原生是部署验收项，不能用协议夹具或 CI 配置替代。shared 模式没有默认发布计划，关闭实验开关可回到 per-client。

## 10. 实施文件与验收映射

| 模块/入口 | 职责 | 验收证据 |
| --- | --- | --- |
| application/server/resources.ts | 资源、协议与 COS、同步 | resources.test.ts 的 5 项夹具/账户/输出边界测试 |
| application/server/git-control.ts、git.ts | 凭据、Git bridge、发布 | git-control.test.ts 的 2 项真实 Git HTTP/代码源 API 测试 |
| application/server/machines.ts、runtime 辅助工具 | 备份、恢复、策略与锁 | machines.test.ts 的 4 项磁盘/故障测试；辅助工具 29 项 |
| application/server/runtime.ts、Server 身份接口 | 本机身份/升级 | orphan.integration.test.ts：认领/伪造拒绝/WS 退出/脏文件 |
| application/server/sandbox-runtime.ts、volumes.ts | 镜像与 PVC | SDK 夹具；volumes.test.ts 的分页/UID/等待；实际 Docker 6 阶段 |
| file-service shared-node-watcher 与 process-manager | 崩溃恢复 | 23 项定向 Jest；3 轮 5 连接 native crash 探针 |
| server/src/start-server.ts、main.ts | 关闭协调器与 CLI 退出 | Server 关闭回归；真实浏览器 6 个采样进程退出 |
| Dockerfile、application/runtime/Dockerfile、工作流 | Node 镜像和回归入口 | 实际 x64 构建/70 插件；本机 OpenSandbox HTTP/WS 与维护 E2E |
| scripts/run-local-sandbox-acceptance.sh | 官方 SDK 的私有 Docker 验收 | 随机回环端口、独立 daemon、生成账户与最终资源回收 |

构建、全量 Node/jsdom、类型/静态检查、各层测试的计数和边界统一见 [迁移记录](MIGRATION.md)及 [可移植摘要](node-control-plane-acceptance-20261002.json)。原始进程/事件/容器日志只在忽略的 output/runtime-profiles 中保留。本轮只做本地中文提交，不执行 GitHub 推送。
