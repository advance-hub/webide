# 工作台产品

工作台管理账户、项目、个人开发机与分支工作区；IDE 框架位于仓库根的 `packages/`，由工作台通过本机 Node 或 OpenSandbox 驱动启动。

```text
application/
├── shared/                 # 前后端共用的传输契约
├── src/                    # 浏览器产品界面
│   ├── api/                # HTTP 客户端与错误
│   ├── domain/             # 展示文案与格式转换
│   ├── state/              # 账户状态、刷新与操作协调
│   ├── routing/            # URL 路由与导航类型
│   ├── components/         # 复用组件与业务面板
│   ├── views/              # 按页面组织的业务界面
│   ├── styles/             # 主题变量、基础布局、组件适配
│   ├── app.tsx             # 页面调度
│   └── main.tsx            # React 挂载与语言设置
├── server/
│   ├── platform/           # 配置、存储、队列、进程与输入校验
│   ├── domain/             # 持久模型、驱动接口、资源锁键
│   ├── modules/            # 账户、仓库、Git、资源、开发机与工作区业务
│   ├── infrastructure/     # Docker、Kubernetes 与官方 OpenSandbox SDK
│   ├── runtime/            # 本机与沙箱驱动、运行时指纹
│   ├── http/               # 中间件、IDE 代理、按业务拆分的路由
│   ├── __tests__/          # 单元与集成测试
│   ├── workbench.ts        # 唯一依赖组装与资源释放入口
│   └── main.ts             # 可执行启动入口
├── runtime/                # 在开发机内执行的命令与镜像配套文件
└── acceptance/             # 独立的真实 OpenSandbox 验收入口
```

从仓库根执行 `pnpm dev` 启动源码开发；`pnpm start` 校验构建后执行编译入口。工作台包的 `build` 同时检查类型、构建浏览器界面和服务端 `main.mjs`。`dist/`、`server/main.mjs` 与 `.data/` 都是生成或运行数据，不提交。

业务定位：接口从 `server/http/routes/` 进入，状态变更由 `server/modules/` 执行，外部环境通过 `server/domain/runtime.ts` 的驱动接口访问。共享类型只包含传输契约，不能导入 React、Koa 或运行实现。

工程边界和失败语义见 [架构说明](../docs/architecture/product-structure.md)，环境变量、安装和沙箱验收见 [运行说明](../docs/RUNNING.md)，接口契约见 [控制面说明](../docs/NODE-CONTROL-PLANE.md)。
