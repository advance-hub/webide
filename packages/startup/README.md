# OpenSumi Startup

`CommonBrowserModules` 与 `CommonNodeModules` 只保留默认 IDE 核心能力。`client/`、`server/` 产品入口动态加载 AI、Notebook 与 Collaboration，因此默认产物不会因为 ProductProfile 的声明而静态带入可选实现。旧模块数组通过兼容 helper 装配；旧 `entry/web` 产品目录已不在本仓库中。这里保证可选实现的加载方式和模块顺序，不承诺新旧产物的 chunk graph 逐字节相同。Electron 与可覆盖模块数组的 CLI 仍是独立 variant，尚未强行套用默认 Profile。

默认模块现在同时生成 `CommonBrowserRuntimePlan` 和 `CommonNodeRuntimePlan`。两端共用 `OpenSumiDefaultProductProfile`，其中 `ai`、`notebook`、`collaboration` 是显式 optional feature。动态入口在 import 完成后编译 plan；`composeLegacyEntrypointModules` 为旧模块数组提供 framework 构造器前缀校验与可选模块顺序兼容。现有 `BrowserModule` / `NodeModule` 仍通过 Legacy Adapter 转成 runtime facet。新增或移除能力时，需要同步更新 profile 与对应 runtime catalog。

首批 `declared` 能力包括 File Service、Process Factory 与 Extension Host Control。Node 分别提供 `opensumi.files.disk-service@1`、`opensumi.process.factory@1`、`opensumi.extensions.host-control@1`；Browser 对跨运行时的 File / Extension Port 显式声明 Node provider，Node 内的 Search / File Search 显式消费 Process Port。`toRuntimePlanContract` 会剥离构造器，`compileRuntimeTopologyContract` 在显式收到两端 contract 时校验完整 runtime 集合、feature 集合、provider、版本和 scope，并生成稳定的 `v1:sha256:` digest。

默认 web 产品现已在 `RuntimeTopologyHandshake` 逻辑通道交换严格、限长的 Browser/Node contract。Node 的 hello 在 `server-ready` 前发送，Browser 回传 plan 后双方独立编译完整 topology；只有 digest 一致才会打开 `RPCService`。Fury 的固定控制帧和现有 RPC wire 没有加字段，Gateway 与 Electron 仍透传同一种 `data.content`。一次总 deadline 覆盖 channel open、hello、validate 与 result；每个物理连接只允许一次验证和一个终态，已成功运行的 Browser 若在重连时验证失败会终止 socket 并显示可复制的诊断。默认策略为 `compatible`：从未尝试握手的旧 client 可在滚动升级期继续连接，但 pending、rejected、畸形或已见过 v1 后降级的连接都不会回退；该降级记忆覆盖当前 Browser preflight 生命周期，整页重载会开始新生命周期。`required` 仅接受完成 v1 的连接，`off` 保留给尚未提供 plan 的 embedder。digest 是兼容性指纹，不是认证或静态资源远程证明；64 KiB 只限制 Fury 解码后的协议 JSON 与拓扑编译，并不代替传输层 payload、连接数、速率、内存和背压限制。当前仍由既有模块、DI 与 RPC adapter 执行，没有新旧双跑或结果比较，所以这些 facet 只报告 `declared`，`shadow` 仍为 0。

Extension RPC facade 现在把 `clientId` 固定在 connection child scope：跨 session 调用和二次换绑会被拒绝，旧连接销毁也不会删除重连后的新 facade。Profiler 同样使用绑定身份，只暴露预期 RPC surface，并通过 connection-scoped File Service 保存 profile，使 `blockPatterns` 继续生效。这些是现有 adapter 的安全与生命周期修正，不代表 Extension Host 已迁移成完整 `RuntimeHandle`。

如需自定义 workspace 目录，可以通过传递 `MY_WORKSPACE` 环境变量指定：

```bash
MY_WORKSPACE=/absolute/workspace pnpm dev:ide
```
