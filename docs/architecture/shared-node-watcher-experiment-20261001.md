# Node watcher 共享实验（2026-10-01）

> 历史测量记录：2026-10-02 当前产品已删除 Go Agent/Gateway、相关协议和构建入口。下文 Node/Go 数字与失败记录原样保留，仅作为原项目实验来源，不表示本版提供 Go 模式。

> 原项目的历史实验记录：数据来自 `opensumi` 的 `32dff6c` 基线及当时未提交的共享 watcher 实现，不代表重建版的重新验收。重建版保留 Node 与共享 Node 两种探针，不包含 Go 对照；当前启用方式与移植验收见 [共享 watcher](./shared-node-watcher.md)。

共享 Node 已在本机移除大部分重复 watcher 进程的内存成本，但整棵 IDE 的性能尚未通过稳定性验收。默认继续按连接启动 Node watcher；设置 `OPENSUMI_NODE_WATCHER_MODE=shared` 才启用实验。

## 场景与结果

macOS ARM64、Node 24.16.0、OpenSumi 前后端源码快照，一个 Server/仓库的 5 个独立连接，固定 9 个基础扩展。每个浏览器连接拥有扩展宿主和终端；每种模式跑 3 轮并轮换顺序。Go 只执行 Watch，搜索、Quick Open、连接和扩展仍走 Node，关闭 Gateway，禁止回退。

下面是每轮 P95 RSS 的三轮中位数，单位 MiB；完整 IDE 服务树包含语言服务子进程，不含 Chromium。

| 模式                | 独立原生监听测试的 watcher | 完整 IDE 中的 watcher | 完整 IDE 服务树 |
| ------------------- | -------------------------: | --------------------: | --------------: |
| Node 每连接一个进程 |                      414.7 |                 228.2 |          3072.5 |
| 共享 Node           |                       82.5 |                  45.6 |          4092.3 |
| Go Watch Agent      |                       15.0 |                  12.9 |          2726.5 |

独立原生测试强制 Parcel、预热 5 秒；浏览器使用现有默认后端，在搜索与 Quick Open 后预热 20 秒。两组数据的边界不同，不能相互代替。

完整 IDE 中 watcher 节省 182.6 MiB（80.0%），追回原 Node/Go watcher 差距的 84.8%；共享后 Go 仍轻约 32.7 MiB。此结果证明进程共享对该角色有明显收益，没有证明 Node 24 与 Go 在所有工作负载上性能相同。

整树三轮 P95 为 Node `3072.5/4817.5/2069.5`、共享 Node `3141.2/4719.4/4092.3`、Go `2726.5/2239.3/3721.7` MiB。**共享 Node 的整树中位数反而更高。** 语言服务子进程占主要内存，10 核主机的 load average 约 85–237；尚未通过安静主机和索引完成后的对照确定原因，所以不能据局部节省承诺整体内存下降、延迟改善或默认上线。

## 实现和验证

共享池由 Server 根注入器持有，每种后端一个子进程。仅相同 URI、合并后的排除规则、递归与轮询策略合并原生订阅。每个连接持有自己的逻辑 ID 和租约，关闭时释放自身订阅；最后一个租约或服务停止回收宿主。不同策略和不同根仍需独立原生订阅，内部事件关联 ID 在送到公开客户端前移除。

- 5 个 Jest 套件、35 个测试通过，覆盖依赖注入单例、订阅引用、路径/规则隔离、错误/溢出分发、迟到注册、启动失败、停止时取消和释放失败。
- 9 轮原生测试、63 个真实磁盘操作步骤通过，另检查隔离、关闭客户端和最终进程回收；仓库已有 README 的修改按原字节恢复。默认后端下的独立 5 客户端共享测试也通过。
- 9 轮浏览器测试，每轮 5 个连接，精确搜索返回 8 个结果/8 个文件，Quick Open 返回指定文件；扩展激活和拓扑检查通过，unexpected browser error 为 0，关闭后回收成功，服务正常退出，全部采样 PID 已退出。

完整原始事件、进程命令、各轮延迟、负载和 SHA-256 凭据索引保存在本机 `output/runtime-profiles/shared-node-watcher-20261001/`，不进入 Git；可移植结果见 [summary JSON](./shared-node-watcher-experiment-20261001.json)。测试入口为 `scripts/profile-node-watcher-sharing.ts`，工作区必须是带 README.md 的隔离 `/snapshots/` 路径。

## 限制和保留的失败记录

五个独立托管的 IDE Server 不会共享此池；五个不同项目需要各自订阅。本次同服同仓库的数据不能直接外推。Windows/Linux、共享宿主异常退出后的自动重订阅尚未专项验收。

额外 CLI 检查中，在浏览器仍连接时先停止 Server，再关闭浏览器，关闭报告显示四个阶段均完成、耗时 131 ms，watcher、扩展和终端子进程均消失，但 Server 主进程仍驻留。`lsof` 无网络或 Unix socket，仍有 PTY 文件描述符；尚未确定这些句柄是否就是根因，也未证明属于共享 watcher 的回归。此场景记为未通过，保存 `active-stop-case.json`、`ui-server.log` 和 `ui-post-shutdown-handles.log` 后强制清理了该测试 Server。正式九轮覆盖的是先关浏览器、再停 Server，不能替代活跃连接下的退出验收。

真实进程计数发现最初的 DI `useFactory` 不缓存共享池，改为 `useClass` 单例并补了跨连接注入器回归。早期新建文件再修改的探针在 Node Parcel 和 Go FSEvents 下均出现 ADDED/UPDATED 类型差异，已保留原始记录；正式保存探针使用仓库里已有的文件，快速创建/修改语义另需调查。相对 URI、继承 tsx loader、非法 fallback=off、Volta 包装器作为根 PID 的测量尝试也保留并排除。正式 Node 子进程运行编译后的 JavaScript，浏览器 Server 使用实际 process.execPath。
