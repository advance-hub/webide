# IDE 浏览器入口

`client/src/main.tsx` 负责 OpenSumi 浏览器应用组合，框架组件位于 `packages/`。打包器使用 Rspack 2；产品入口通过 SWC 转换，部分框架源码继续使用 ts-loader 和 TypeScript 6 编译器 API，以保持装饰器元数据与依赖注入行为。框架完整类型检查由 TypeScript 7 单独执行。

从仓库根目录运行：

```sh
pnpm dev:ide
pnpm build:client
pnpm build:client:full
```

独立 IDE 开发前端位于 `http://127.0.0.1:8080`，连接 Node 服务 `8000`。`pnpm start:client` 只启动前端，需要另行启动匹配的服务；`pnpm dev:ai`、`pnpm dev:full` 和协同相关命令组合对应模块。

工作台界面由 `application/src` 和独立的 Rspack 配置负责，使用 `pnpm dev` 或 `pnpm start` 运行。完整命令和端口见 [运行说明](../docs/RUNNING.md)。
