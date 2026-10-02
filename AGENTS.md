# 工程约定

先阅读 [产品目录](application/README.md) 和 [架构边界](docs/architecture/product-structure.md)，再修改所属模块。

- 工作台组装只放在 `application/server/workbench.ts`；业务模块不得导入 HTTP、运行驱动的具体实现或组装根。
- 前后端共用类型放在 `application/shared/`；不能从浏览器源码导出服务端模型。
- 运行驱动依赖 `RepositorySource` 和 `RuntimeDriver` 契约。新增外部后端先实现契约，再由组装根注入。
- 说明性注释使用中文，解释约束、所有权或失败原因。版权、许可证、协议标识和编译器指令保留原文语法。
- 删除代码前检查入口、动态导入、配置、镜像和测试调用方；不能根据文件名或静态搜索结果直接删除扩展能力。
- 生成产物、凭据、运行数据和验收原始证据不进入 Git；不要修改有效构建凭据来绕过重新构建。
- 不改变 OpenSumi 公开包路径、扩展 API 和持久数据格式，除非任务明确包含相应迁移。
- 修改产品后执行 `pnpm check:product`、相关类型检查及测试；修改构建、路径或运行驱动时执行 `pnpm build:all` 和实际运行验收。
- 需要提交时按职责拆分，使用中文 Conventional Commits；只暂存本次任务明确修改的文件。
