# Node IDE 服务

`server/src/main.ts` 是工作台托管的 OpenSumi IDE 服务入口。运行时使用 Node.js 24，负责 OpenSumi RPC、扩展宿主、文件监听与搜索、终端以及可选协同服务。当前产品运行模式固定为 `node`，不支持通过 `hybrid` 启动 Go Gateway 或 Workspace Agent。

从仓库根目录运行：

```sh
pnpm dev:ide
pnpm build:server
HOST=127.0.0.1 PORT=4317 pnpm --dir server start
```

生产服务读取 `server/dist` 和构建后的框架包；直接运行前应先执行 `pnpm run build:all`。默认生产端口为 `4317`，独立 IDE 开发服务使用 `8000`。工作台托管的本机 IDE 动态分配端口，并通过工作区入口代理访问。

共享 watcher 需要 `OPENSUMI_NODE_WATCHER_MODE=shared`。每个 IDE Server 的根注入器持有自己的共享池，连接保留独立订阅与租约。详细边界与验收结果见 [共享 watcher](../docs/architecture/shared-node-watcher.md)。

`server/scripts` 和部分框架适配器仍保留历史 Go 实验代码与诊断工具，它们不代表当前产品支持的启动模式。完整迁移状态见 [迁移状态](../docs/MIGRATION.md)。
