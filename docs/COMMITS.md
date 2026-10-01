# 本地提交记录

本次整理保留 OpenSumi 的原始历史，从上游基线 `9a7057aec` 开始，按变更用途拆分提交。分支为 `main`，`origin` 已配置为 `https://github.com/advance-hub/webide.git`，原 OpenSumi 远程保留为 `upstream`。

按用户选择，本轮只完成本地提交，未推送到 GitHub。首次推送成功后再建立 `origin/main` 的跟踪关系。

## 实现与工程提交

| 提交        | 主题                                                              |
| ----------- | ----------------------------------------------------------------- |
| `b4acaf9c6` | chore(toolchain): 固定 Node 24 与 pnpm 并迁移 TypeScript 7 工具链 |
| `59725f8f6` | refactor(core): 整理核心包入口与运行时依赖边界                    |
| `839d61279` | refactor(ui): 适配组件布局与编辑器基础设施                        |
| `bec729547` | refactor(ide): 迁移编辑文件终端与工作区功能                       |
| `9674bac05` | refactor(extensions): 整合扩展宿主调试与会话管理                  |
| `d4cad2eb5` | fix(hooks): 串行执行格式化与 ESLint 避免并发改写暂存文件          |
| `3c2666217` | refactor(startup): 整合产品组合与 AI 工作台模块                   |
| `160a09814` | feat(build): 增加产物校验与统一启动编排                           |
| `75f15705c` | feat(runtime): 接入 Rspack 产品入口与 Node IDE 服务               |
| `dbb64def2` | feat(plugins): 完善内置扩展下载校验与扫描索引                     |
| `2a552af54` | feat(workspace): 迁移 Git Maven 与开发机辅助工具                  |
| `7e72e2bf9` | feat(workbench): 实现 Koa 工作台控制面与沙箱驱动                  |
| `5a057f12c` | feat(workbench-ui): 接入项目工作区与开发机管理界面                |
| `e45b63556` | feat(watcher): 移植服务级共享 Node watcher 实验                   |
| `a610f29b4` | chore(scripts): 统一工程维护与诊断脚本入口                        |
| `f13eb9607` | fix(scripts): 移除重复的工作台测试命令定义                        |

本页、README、运行配置、迁移进度和 watcher 实验说明在最后的 `docs(webide): 补齐运行配置迁移进度与实验验收记录` 提交中一起保存。可以查看全部 17 次提交的完整说明：

```sh
git log --reverse --format=fuller 9a7057aec..HEAD
```

## 验证与边界

所有提交均执行仓库的格式化、ESLint 和 commitlint 钩子，没有跳过钩子。每批暂存前检查文件范围，并执行 `git diff --cached --check`。

Prettier 和 ESLint 原先会并发改写相同文件，AI 模块批次曾出现临时 JSX 解析错误；单独检查源文件正常。独立修复提交将两个写入任务串行执行，随后该批次通过。

具体构建与测试结果见 [迁移状态](MIGRATION.md)。本地配置、数据库、凭据、插件下载缓存和原始性能采样不进入提交。共享 watcher 保留实验开关，完整平台的剩余迁移和验收事项继续记录在迁移状态中。
