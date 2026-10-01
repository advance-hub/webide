# Electron 实践层

Electron 是独立的桌面入口，不属于工作台 `pnpm start` 的启动路径。本版将其构建配置迁移为 Rspack，但当前 Web 产品验收未覆盖 Electron 运行。以下命令沿用桌面开发流程，原生模块需要匹配 Electron ABI。

## Electron 版本运行步骤

> 注意从外部的 `pnpm run start:electron` 执行后不要再次执行，否则会花很多的时间进行再次依赖安装和编译，直接在 `tools/electron` 执行 `pnpm run start` 即可。

```shell
cd ../../
pnpm install
pnpm run init

cd tools/electron
pnpm install
pnpm run link-local
pnpm run build
pnpm run rebuild-native --force-rebuild=true
pnpm run start
```

## 如何开发

首先需要在根目录执行一次 `build`，然后 `watch`。

```bash
pnpm run build
pnpm run watch
```

然后打开当前文件夹，执行：

```bash
pnpm run watch:browser
# ... 或者其他的你需要 watch 的层
```

然后再开一个终端，进行：

```bash
pnpm run start
```

打开编辑器之后，当代码有新改动时，打开编辑器内的命令行：<kbd>shift</kbd>+<kbd>command</kbd>+<kbd>p</kbd>，输入 `Reload Window` 即可看到新变化。
