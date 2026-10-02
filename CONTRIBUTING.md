# 开发约定

安装与启动见 [运行说明](docs/RUNNING.md)，产品目录见 [application/README.md](application/README.md)，模块规则见 [AGENTS.md](AGENTS.md)。

使用仓库固定的 Node.js 24.16.0 与 pnpm 12.8.1，执行 `pnpm install --frozen-lockfile`。通过 `pnpm dev` 修改工作台，通过 `pnpm dev:ide` 调试独立 IDE；修改公共包时使用公开入口，不能绕过 exports 引用私有源码。

提交前按改动范围执行以下命令：

```sh
pnpm check:product              # 工作台模块依赖、路径和中文注释
pnpm check:architecture         # OpenSumi 工作区依赖与公开包契约
pnpm typecheck:scripts          # 工程脚本类型检查
pnpm test:workbench             # 控制面与真实本机 IDE 集成测试
pnpm test:application-runtime   # 开发机内运行命令测试
pnpm test:runtime-scripts       # 构建与工程门禁回归
pnpm build:all                  # 完整编译与产物凭据
pnpm test                      # 完整 Node/jsdom 框架回归
```

说明性注释使用中文，优先说明约束、资源所有权和失败语义，不逐行复述代码。保持版权和机器指令原文。删除实现时同步检查运行入口、配置、Docker、动态加载和测试；不能使用停用测试或伪造构建凭据作为通过依据。

使用中文 Conventional Commits，按独立意图拆分提交。不要提交 `.env`、运行数据、生成产物或本机验收日志。新增行为应提供相应的边界或集成验证；结构调整应验证原有功能路径仍然成立。

上游框架开发的背景可参考 [OpenSumi 贡献说明](https://opensumi.com/en/docs/develop/how-to-contribute)。本仓库的运行命令和验收结果以本地文档为准。
