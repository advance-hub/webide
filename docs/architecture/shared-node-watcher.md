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

探针只允许 `node`、`shared-node`，始终关闭 Workspace Agent 和 Gateway。工作区必须是带 README.md 的隔离 `/snapshots/` 路径；`default` 可替换最后的 `parcel`。

## 性能证据与限制

[原项目实验记录](./shared-node-watcher-experiment-20261001.md)和 [summary JSON](./shared-node-watcher-experiment-20261001.json)保留为历史证据。本次验证不包含扩展宿主或 Chromium，也没有重跑原项目九轮完整 IDE 浏览器性能对照，不能据此宣称整棵 IDE 内存或延迟改善。

Windows/Linux、共享宿主异常退出后的自动重订阅、活跃浏览器连接下的 Server 退出仍未在本次移植中验收。原记录中活跃连接下 Server 主进程驻留的失败没有因本次移植而被宣告修复。
