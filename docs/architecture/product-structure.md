# WebIDE 产品模块与工程边界

> 评审目标：将工作台的账户、业务状态、运行驱动与 HTTP 传输分开，以共享契约连接浏览器和服务端，以一个组装根管理资源；保持现有接口、持久数据和 OpenSumi 扩展兼容，删除经过调用检查确认失效的入口。

## 1. 现状与改动依据

重构前，`application/server/app.ts` 的 996 行同时构造依赖、处理账户权限、注册业务接口、调度生命周期任务并代理 IDE HTTP/WebSocket。服务端仓库和 Maven 模块从 `application/src/domain.ts` 引用类型，该文件又包含浏览器请求函数和展示文案。依赖驱动接口时还会引用包含 `LocalRuntime` 的实现文件。

当前目录见 [产品文件树](../../application/README.md)。`server/workbench.ts` 只构造服务、连接回调并统一启动和释放资源。原来混在一个文件内的路由、鉴权、工作区任务和 IDE 代理分别拥有明确入口。`shared/contracts.ts`、`server/domain/models.ts` 和 `src/domain/presentation.ts` 分别负责传输模型、持久模型与界面展示。

| 原问题 | 当前处理 | 可观察证据 |
| --- | --- | --- |
| 服务端引用浏览器源码 | 传输类型提取到 shared，持久模型在 domain 扩展账户归属 | 产品依赖检查拒绝 server 到 src 的导入 |
| 路由与业务状态混合 | HTTP 按业务拆分，工作区操作和备份操作回到业务模块 | 控制面原有集成测试继续覆盖相同 API |
| 驱动接口绑定具体仓库实现 | RuntimeDriver 依赖最小 RepositorySource 契约 | domain 和 runtime 禁止回依赖 modules 或 HTTP |
| 源码与打包目录的相对位置不同 | platform/paths.ts 沿父目录识别仓库标识 | 编译入口在临时工作目录启动并访问页面 |
| Docker 重复声明控制面打包命令 | 统一使用 scripts/build-application-server.ts | 本机与镜像都通过 build:all 生成 main.mjs |
| 五份辅助命令重复解析输入 | runtime/command-input.cjs 统一私有文件与 Base64 输入 | 运行辅助命令的原有回归测试 |

## 2. 目标与不变项

目标是让新功能可以根据职责定位文件，阻止跨层依赖重新出现，并让本机、生产打包和 Docker 使用一致的资源路径。

不变项：HTTP 方法与 URI、账户归属校验、公开响应的凭据脱敏、SQLite 数据结构、现有工作区目录、固定 Git 基线、资源锁、备份事务和开发机 OS 隔离保持原有契约。OpenSumi 的公共包名、exports 和扩展 API 保持兼容；共享 watcher 仍需显式开启。

非目标：本次不调整 IDE 界面设计，不替换数据库，不改变沙箱供应方，也不将 Electron、扩展宿主、语言服务或测试夹具按文件名称判断为无用代码。平台功能的环境验收限制仍以 [控制面验收](../NODE-CONTROL-PLANE.md) 为准。

## 3. 架构设计：模块所有权与依赖方向

| 模块 | 状态或资源所有权 | 允许依赖 |
| --- | --- | --- |
| shared | 无运行状态，仅传输契约 | shared 内部 |
| src/api、domain、state、routing、components、views | 浏览器请求、界面状态、导航与展示 | 浏览器模块与 shared |
| server/platform | 环境配置、SQLite、加密、队列和子进程执行 | platform 内部与 Node/已声明依赖 |
| server/domain | 持久模型、运行接口、锁键 | domain、shared、platform 的基础类型 |
| server/modules | 账户归属、Git 发布、资源配置、开发机事务、工作区生命周期 | modules、domain、shared、platform |
| server/infrastructure | Docker、Kubernetes、官方 OpenSandbox SDK 适配 | infrastructure、domain、platform |
| server/runtime | 本机与沙箱运行实现、运行时指纹 | runtime、infrastructure、domain、platform |
| server/http | 来源校验、JSON、会话、HTTP/WS 代理、业务路由 | 已注入的业务服务与驱动接口 |
| server/workbench.ts | 创建服务实例与最终资源释放 | 所有需要组装的服务 |
| application/runtime | 在开发机进程内执行的辅助命令 | 同目录辅助模块与 Node/镜像已安装依赖 |

路由通过 `RouteServices` 描述可注入对象，各路由函数再用 `Pick` 收窄实际依赖。工作区任务使用独立的 `WorkspaceServices`，业务模块不导入路由上下文。驱动通过 `RepositorySource` 获取基线和文件位置，不读取 HTTP 请求或浏览器状态。

示例调用链为 `POST /api/workspaces/:id/start → AccessControl.workspace → WorkspaceOperations.lifecycle → Jobs → RuntimeDriver`。备份链为 `HTTP backups → Machines.backupAction → 资源锁与持久任务 → 驱动归档/恢复`。IDE 入口票据和代理连接由 `IDEProxy` 持有，维护任务通过注入的连接查询判断开发机是否空闲。

## 4. 失败、兼容与运行入口

控制面重启时，将中断的工作区任务置为可见失败；开发机恢复事务继续使用原有日志与显式恢复接口。任务锁和持久化提交仍由业务模块维护，HTTP 只负责身份、输入和响应转换。恢复编辑器连接失败时，工作区保存可见的同步失败状态。

`readJSONBody` 先按原始字节计数，再一次性解码，大小上限仍为 1 MiB。空请求沿用空对象，非法 JSON、null、数组和标量统一返回 400，超限返回 413，避免错误类型进入业务层后成为 500。

并发 `Workbench.close()` 调用等待同一个 Promise。首次调用立即拒绝新 HTTP 和 WS 请求，随后停止维护任务、关闭代理连接、取消 Maven、排空队列并释放驱动、沙箱和存储。代理在异步环境检查后再次核对关闭状态，防止关闭期间接纳迟到连接。

开发入口继续使用 `tsx watch server/main.ts`，生产入口执行 `node server/main.mjs`。`pnpm build:all` 检查源码摘要并生成框架、IDE、工作台界面和控制面产物；`main.mjs` 纳入必需输出，shared 和 runtime 文件纳入输入摘要。构建失败或构建期间源码变化不会发布有效凭据。

目录迁移不需要数据迁移。内部源码路径已同步更新测试、文档、Docker 和真实验收脚本；这些路径不是公开包接口。回滚必须同时恢复源码和构建配置，再执行完整构建，不能继续沿用当前生成产物。

## 5. 删除与保留依据

删除根目录的 `jest.config.js`、`jest.setup.base.js`：实际测试运行器已统一使用 `configs/jest/jest.config.ts`，旧配置还引用不存在的根目录 setup 文件。删除 `changelog-old`：它指向不存在的 `scripts/changelog/index.js`，有效入口为 TypeScript 版本。

清除三处已注释的旧执行代码与产品中未使用的导入；五个辅助命令共用输入解析，避免独立实现漂移。旧 `.vscode/launch.json` 中的 webpack、ts-node、已失效 changelog 入口替换为当前工作台、独立 IDE 和测试入口。

框架包、动态扩展加载、原生运行后端、验收夹具与历史性能证据继续保留。产品、IDE 入口和工程脚本的说明性注释已改为中文，版权和机器指令保留原文语法。上游框架既有 API 说明没有进行全仓语言改写；后续修改遵循中文注释约定，避免把结构调整扩展成未经验证的框架 API 清理。

## 6. 自动检查与验收

`pnpm check:product` 使用 TypeScript 语法树检查相对源码导入、静态/动态/CommonJS 依赖、模块层次、循环和说明性注释。注释检查包含空代码块与 JSX，不将字符串、URL 或正则识别为注释；版权、许可证和编译器元数据保留原文。样式和其他静态资源的有效性由真实构建验证。

门禁已纳入 `test:runtime-scripts` 和产品平台工作流，相关规则的反例由 `check-product-structure.test.ts` 覆盖。产品 ESLint 禁止未使用的导入与变量，允许显式丢弃的下划线变量和对象剩余字段。

| 验收入口                                 | 必须验证的结果                                                 |
| ---------------------------------------- | -------------------------------------------------------------- |
| check:product、test:product-structure    | 当前产品通过；跨层、循环、缺失文件与英文说明反例被拒绝         |
| application typecheck、typecheck:scripts | 迁移后的类型、入口和工程脚本可解析                             |
| test:workbench                           | 原有 Git、资源、备份、身份、PVC、真实 IDE HTTP/WS 路径继续通过 |
| http-boundary.test.ts                    | 中文 JSON 跨块、大小边界、非法对象和并发关闭                   |
| bundle.integration.test.ts               | 编译服务从临时目录启动、返回页面并正常退出                     |
| test:application-runtime                 | 共用输入解析后的 Git、Maven、偏好、恢复及进程归属行为保持      |
| build:all、check:artifacts               | 真实构建成功，必需输出和输入摘要一致                           |
| 本机隔离 Docker/OpenSandbox              | 当前控制面完成真实 SDK、账户隔离、IDE 代理、备份、升级和卷释放 |

验证结果与本机原始日志分开保存；原始日志位于忽略目录 `output/refactor/`，不能把此前版本的验收计数当作本次执行结果。完整 Node/jsdom 上游回归和 Windows/Kubernetes 等环境的边界继续单独记录。

## 7. 本次执行结果（2026-10-02）

产品结构检查覆盖 112 个源码文件，未发现跨层依赖、循环、缺失文件或不符合约定的说明性注释。组装根由原来的 996 行缩减为 136 行。第二批提交只修改注释的 34 个源码文件，经去除注释后的语法树比较，结构变化为零。

| 实际执行范围                      | 结果                              |
| --------------------------------- | --------------------------------- |
| 工作台控制面及生产打包入口        | 25 项通过，0 失败                 |
| 开发机辅助命令                    | 29 项通过，0 失败                 |
| 工程脚本、模块边界及公开 API 契约 | 67 项通过，0 失败                 |
| Server 诊断                       | 26 项通过，0 失败                 |
| 上游 Node 回归                    | 140 套件，1,481 项通过，29 项跳过 |
| 上游 jsdom 回归                   | 350 套件，3,264 项通过，28 项跳过 |
| 隔离 Docker/OpenSandbox           | 六阶段通过，测试资源已回收        |

产品与脚本类型检查、ESLint、严格架构文档检查、完整构建和构建产物摘要检查均通过。生产控制面从不同工作目录启动，以及 Docker 内的页面响应和正常退出均已验证。构建保留上游框架既有警告。

可移植计数、镜像标识和环境边界见 [本轮验收摘要](product-structure-acceptance-20261002.json)。真实沙箱覆盖双账户启动、Node 24 与账户隔离、IDE HTTP/WS、加密备份与脏文件恢复、保留数据卷的运行时升级，以及容器和数据卷的实际删除。升级使用可区分指纹的测试镜像；本轮没有新增 Windows 原生、真实 Kubernetes 或外部云资源验收，也没有据此承诺整棵 IDE 的性能改善。
