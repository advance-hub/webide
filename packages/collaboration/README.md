# Collaboration Module 协同编辑模块

> Make OpenSumi Collaborative

## 如何使用

只需在 browser 与 node app 的 startup 上添加该模块，并实现`CollaborationModuleContribution`即可使用。

工作台的托管工作区默认使用已认证的同源协同通道，所有者可邀请四名成员；完整权限与验收边界见 [产品协同文档](../../docs/COLLABORATION.md)。托管入口不需要公开独立协同端口，旧实例需更新运行时并重启。

当前仓库的客户端和服务端也保留独立框架开发入口，可使用 Node 路径启动：

```sh
OPENSUMI_RUNTIME_MODE=node pnpm dev:collaboration
```

使用构建产物启动时，客户端构建和服务端启动均需启用协同，并使用相同的端口：

```sh
pnpm build:node
ENABLE_COLLABORATION=1 COLLABORATION_PORT=12345 pnpm build:client
OPENSUMI_RUNTIME_MODE=node ENABLE_COLLABORATION=1 COLLABORATION_PORT=12345 pnpm --dir server start
```

多个浏览器连接同一个工作区后，打开同一文件即可协同编辑。上面的独立端口模式需让浏览器能够访问协同 WebSocket 端口；用户信息可通过 `CollaborationModuleContribution` 提供。托管工作区的身份由控制面注入，复用工作区域名与 IDE 会话。

## 平台支持

目前的实现只支持 Cloud IDE 场景 (Browser + Node)

## 修复与验证

Node.js 24 + pnpm 构建保留原生 Yjs 协同模块。2026-10-01 修复远端替换共享文本后编辑器仍绑定旧文本的问题，并让并发文档初始化共享一次磁盘读取，同时分别保留客户端引用。光标标记使用连接 ID，支持同名用户；用户离开或编辑器销毁时释放标记，昵称更新按纯文本显示。

回归覆盖真实 Yjs 更新、并发初始化与光标生命周期。浏览器验收使用三个独立 Chromium 上下文，核对 Monaco 完整文档与实际磁盘内容，覆盖初始化、独立编辑后合并保存、撤销/重做保留他人编辑、离线重连合并、刷新后从另一客户端保存，以及一人退出后继续编辑。测试驱动为 `scripts/profile-real-workspace.ts`，原始日志和重复运行结果见 `output/playwright/collaboration-repair-20261001/`。

这些修复沿用原有协议和合并算法。2026-10-02 增加托管同源传输和内部鉴权、连接销毁时释放自身文档租约、停止后迟到事件不再创建房间；五人产品验收另见上述产品文档，历史三人结果不能代替本次五人测量。

## 当前限制

- 仅支持了 IDE **编辑器部分**的协同编辑功能
- 暂时仅支持在编辑器编辑文件，未处理外部对 IDE 工作区文件的修改（如 `git pull`, 用其他软件修改了文件内容）
- 未支持 browser-only 与 electron 平台

## Thanks

[yjs -- Shared data types for building collaborative software](https://github.com/yjs/yjs)

[y-websocket -- Websocket Connector for Yjs](https://github.com/yjs/y-websocket)
