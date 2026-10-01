# 共享 Node watcher（实验）

已从原项目 `32dff6c` 基线上的共享 watcher 实验移植实现、回归测试和原生验证入口。默认仍为 `per-client`；显式设置 `OPENSUMI_NODE_WATCHER_MODE=shared` 才启用。

## 启用

工作台启动时设置环境变量：

```sh
OPENSUMI_NODE_WATCHER_MODE=shared pnpm start
```

独立 IDE 开发服务使用 `OPENSUMI_NODE_WATCHER_MODE=shared pnpm dev:ide`。工作台同时向本机 IDE 和沙箱启动命令传递模式；沙箱镜像需包含本次构建的代码。已运行的工作台与工作区 IDE 需要重启才能切换模式。工作台拒绝非法模式值。

## 共享边界

池由 Server 根注入器以 `useClass` 单例持有，每种后端配置复用一个子进程。相同 URI、合并后的排除规则、递归和轮询策略才合并原生订阅；不同策略或不同根仍分别订阅。每个连接有独立逻辑 ID 和租约，关闭只释放自身订阅；最后一个租约或服务停止回收宿主。内部关联 ID 在向公开客户端发送事件前移除。

共享限于一个 IDE Server 的多个连接。工作台为不同工作区启动的独立 IDE Server 不会跨进程共享此池；扩展宿主、语言服务和终端也没有被共享。

## 重建版验收（2026-10-01）

- 5 个 Jest 套件、39 个测试通过，包括服务级单例、订阅引用、规则与路径隔离、失败和溢出分发、迟到注册、启动失败、停止清理，以及默认模式和显式共享模式的路由。
- TypeScript 7 编译 file-service、运行脚本和工作台类型检查通过；修改文件的 ESLint 检查通过。
- 工作台 8 个测试通过，覆盖真实 Node IDE 启停、HTTP/WebSocket 代理、沙箱 SDK、Git、Maven 和模式配置。
- 隔离的 README、前后端和 file-service 源码子集上，按连接 Parcel、共享 Parcel、共享默认后端分别跑一次五连接验证。进程数分别为 5、1、1；21 个真实磁盘操作步骤、连接关闭后的事件隔离和最终回收通过。全部 7 个采样 watcher PID 已退出，README 按原字节恢复。

本机原始结果与回收凭据位于 `output/runtime-profiles/shared-node-watcher-port-20261001/`，不进入 Git。复现入口：

```sh
pnpm exec tsx scripts/profile-node-watcher-sharing.ts shared-node /absolute/snapshots/fixture /absolute/output 5 parcel
```

探针只允许 `node`、`shared-node`；Go Agent、Gateway 与相关配置已从当前产品删除。工作区必须是带 README.md 的隔离 `/snapshots/` 路径；`default` 可替换最后的 `parcel`。

## 性能证据与限制

[原项目实验记录](./shared-node-watcher-experiment-20261001.md)和 [summary JSON](./shared-node-watcher-experiment-20261001.json)保留为历史证据。本次验证不包含扩展宿主或 Chromium，也没有重跑原项目九轮完整 IDE 浏览器性能对照，不能据此宣称整棵 IDE 内存或延迟改善。

## 崩溃恢复与活跃连接退出（2026-10-02）

共享宿主异常退出会向存活租约发送 rescan，然后在同一池重建原生订阅。公开逻辑 ID 保留，旧事件关联 ID 被丢弃；已关闭租约不会重建。恢复启动受取消控制，最多 3 次失败尝试，服务停止取消启动与迟到注册。默认 per-client 保持不变。

23 项定向 Jest 验证崩溃、退租、释放失败和恢复取消。macOS Parcel、macOS 默认后端、Linux x64 Docker Parcel 各跑 5 连接实际崩溃探针，重订阅后的磁盘事件、不同根隔离、关闭连接与最终回收均通过：

```sh
pnpm exec tsx scripts/profile-node-watcher-sharing.ts shared-node /absolute/snapshots/fixture /absolute/output 5 parcel crash
```

原始证据在 output/runtime-profiles/node-recovery-20261002。此次浏览器保留打开的 IDE 和运行中的终端，先对测试 Server 发 SIGTERM；server/connections/contributions/injector 四阶段完成，6 个采样进程在 204 ms 内退出，结果在 node-control-plane-20261002/active-browser-stop.json。该结果覆盖原记录的退出场景，但没有重做其九轮性能测量。

Windows 原生尚未运行，Linux 仅覆盖本机 Docker x64 模拟环境。rescan 是补偿通知，不保证宕机期间短暂事件的逐条重放；反复成功恢复后继续崩溃的长期频率控制仍需专项验收。更多边界见 [控制面方案](../NODE-CONTROL-PLANE.md)。
