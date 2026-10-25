# 启动与五人内存对照（2026-10-25）

两版各三轮的五人验收全部通过，共 360 份内存样本、90 次真实页面语言与导航检查；非预期浏览器错误和容器 OOM 均为 0，活跃连接下停止 Server 及外层隔离资源回收通过。共享工作区的进程树 RSS 降低 17.5%，五台独立开发机合计降低 14.6%。这是本夹具的对照结果，尚不构成稳定容量保证。

本轮分别验证源码扩展宿主冷启动、扩展配置快照，以及实际 Linux/OpenSandbox 中的五人 IDE。三种测量边界不同，不能将局部堆收益直接换算为整个产品的内存降幅。

## 五人内存结果

每项先取每轮 30 份样本的 P95，再取三轮中位数，单位 MiB。独立场景为五台合计，三种内存口径分别统计。

| 场景               | 指标                       |  优化前 |  优化后 |  降低 |
| ------------------ | -------------------------- | ------: | ------: | ----: |
| 五人共享一个工作区 | IDE 进程树 RSS             | 4,688.2 | 3,866.8 | 17.5% |
| 五人共享一个工作区 | IDE 进程树 PSS             | 3,178.2 | 2,571.9 | 19.1% |
| 五人共享一个工作区 | 容器 `memory.current`      | 3,325.9 | 2,758.7 | 17.1% |
| 五人各自独立工作区 | IDE 进程树 RSS             | 5,351.0 | 4,572.1 | 14.6% |
| 五人各自独立工作区 | IDE 进程树 PSS             | 3,610.1 | 3,016.0 | 16.5% |
| 五人各自独立工作区 | 容器 `memory.current` 合计 | 3,910.2 | 3,479.6 | 11.0% |

即本夹具优化后，五人共享工作区的进程树 RSS 约 3.78 GiB，容器内存（含缓存）约 2.69 GiB；五台独立开发机合计分别约 4.46 GiB 和 3.40 GiB。进程共享页、文件缓存归属、未计入的固定服务与交换空间均有不同口径，不能把其中任一数值当作主机完整物理内存预算。

| 场景               | 基线三轮 P95 RSS（MiB）     | 优化后三轮 P95 RSS（MiB）   |
| ------------------ | --------------------------- | --------------------------- |
| 共享工作区         | 4,573.6 / 4,688.2 / 4,711.5 | 3,894.4 / 3,866.8 / 3,833.3 |
| 五台独立工作区合计 | 4,970.0 / 5,351.0 / 5,371.0 | 4,597.4 / 4,563.8 / 4,572.1 |

主要收益来自语言服务拓扑。全部 360 份样本中，基线有十个 tsserver，优化后五个；两边均保留五个类型安装器、十个其他语言服务、五个扩展宿主和五个每连接 watcher，没有 OpenCode 进程。

| 角色 RSS（三轮 P95 中位数，MiB） | 共享：优化前 → 后 | 独立五台合计：优化前 → 后 |
| -------------------------------- | ----------------: | ------------------------: |
| TypeScript 服务及类型安装器      | 2,221.1 → 1,429.1 |         2,212.9 → 1,402.1 |
| 其他语言服务                     |     788.7 → 786.4 |             768.6 → 780.6 |
| 扩展宿主                         | 1,055.4 → 1,038.9 |         1,035.5 → 1,046.8 |
| watcher                          |     393.3 → 395.7 |             383.3 → 396.3 |

TypeScript 角色下降约 35.7% / 36.6%；扩展宿主在共享场景下降约 1.6%，独立场景反而增加约 1.1%。本夹具没有反复持有八十份配置副本，不能据隔离堆探针宣称扩展宿主总内存同幅下降。各角色单独取 P95 和中位数，分项不能直接相加还原整树统计量。

## CPU 与真实页面耗时

采样窗口的容器 CPU P95 三轮中位数，共享为 18.1% → 9.2%，独立五台合计为 21.7% → 18.0%；一个逻辑核为 100%，含采样开销。共享基线三轮分别为 49.7%、11.7%、18.1%，受外部负载与后台任务影响明显，不能将这一结果当作持续编辑或构建的 CPU 降幅承诺。

每版 45 次页面检查合并统计下表，单位毫秒；格式为 P50 / P95。这一统计与内存的“每轮 P95 后取中位数”不同。

| 实际页面操作                      | 优化前 P50 / P95 | 优化后 P50 / P95 |
| --------------------------------- | ---------------: | ---------------: |
| 进入 IDE 至文档和同源 Worker 就绪 |    2,604 / 9,709 |    2,505 / 2,913 |
| 函数补全出现                      |      323 / 2,003 |        318 / 422 |
| 写入类型错误至真实诊断展示        |      671 / 1,441 |      666 / 1,219 |
| 精确搜索返回 8 个结果 / 8 个文件  |         42 / 151 |          40 / 53 |
| Quick Open 首个目标结果出现       |        143 / 233 |        139 / 152 |

页面就绪计时始于已取得入口票据之后，不含开发机创建、构建和完整终端就绪；后续终端与全部功能仍须通过。补全和诊断包含键盘、渲染与断言；Quick Open 计时截至精确结果可选，回车打开、标签和全文检查另外执行。这些结果不能直接当作内部 RPC 耗时。两版 P50 接近；本轮优化版的尾部较低，但主机负载未受控，不据此承诺所有工作负载的延迟改善。

内存采样窗口的一分钟主机负载，基线为 12.9–121.8，优化为 10.7–109.8；主机只有十个逻辑核。交换空间旁路观察共 1,153 次、无读取错误，覆盖 29 个测试容器，观察到的最大单容器历史峰值约 64.4 MiB。它在第一轮共享采样之后启动，早期另存快照，且可能漏掉容器删除前最后一次变化，不能声称全程未换页。稳定容量验收仍为 `false`。

## 实现边界

- 源码模式扩展子进程使用 `ts-node/register/transpile-only`，完整类型检查保留在构建与门禁。IPC 就绪期限仍为 15 秒。显式设置 TypeScript 根目录，装饰协议转换使用类型导入与原数值映射，避免 Node 加载浏览器编辑器入口。
- 客户端直接声明实际使用的 `@opensumi/ide-core-common` 工作区依赖，锁文件同步声明。本轮没有变更第三方依赖版本。
- 对 `@opensumi/monaco-editor-core@0.54.0-patch.2` 使用固定版本补丁，接住单词高亮延迟任务在切换模型时产生的取消拒绝。非取消错误仍由原错误处理器报告；真实编辑器回归在原实现上两项失败，补丁后两项通过。补丁文件进入构建指纹。
- 异步补全按文档版本识别已经失效的请求，旧位置错误和旧结果不进入缓存；详情解析保留继续输入后复用完整列表的行为，只转换实际返回项，减少未使用回退项的命令注册。这遵循 [VS Code 的补全与延迟解析契约](https://code.visualstudio.com/api/references/vscode-api#CompletionItemProvider)，不为请求复制整份文档。
- 托管运行时默认设置 `typescript.tsserver.useSyntaxServer=never`，由每个连接的同一个 TypeScript Server 承担语法和语义处理。显式配置 `auto` 的用户保持原选择。没有跨用户共享语言服务，没有关闭诊断、补全、自动类型获取、ESLint 或 SQLTools。
- 扩展配置的写时复制只复制所请求的配置值，返回的小对象不再保留或复制整个配置根。保留配置隔离、旧快照和复制后的子对象引用语义，并修复对象属性名包含点时的路径歧义。
- 协同事务按变更前的模型偏移计算全部编辑，一次性通知 Monaco，避免多处替换时向语言服务暴露中间全文；不为此复制整个文件。真实 Monaco/Yjs 回归覆盖 LF、CRLF、中文、代理对、撤销重做与仅属性变化，原实现三项失败，修复后十四项通过。
- 两组都保持每连接 Node watcher、五个实际扩展宿主和原来的 70 个内置扩展，没有发送 AI 请求。

## 源码宿主冷启动

macOS ARM64、Node 24.16.0。使用同一份修复后的源码，只交替更换子进程加载器；等待真实 IPC 连接和 `ready` 事件，每种运行三轮。

| 加载器                | 三轮就绪时间（秒）    | 中位数（秒） |
| --------------------- | --------------------- | -----------: |
| 原 `ts-node/register` | 8.947 / 4.645 / 9.295 |        8.947 |
| 仅转译加载器          | 1.997 / 1.904 / 3.551 |        1.997 |

本组在启动修复阶段执行，中位数缩短约 77.7%，仅表示源码扩展宿主就绪，不是生产 IDE 全页面启动时间，也不是后续所有改动的整体启动对照。主机一分钟负载约 28.4–39.5。早期原加载器在 15 秒内未就绪的记录保留；仅转译接入时曾遇到 TypeScript 根目录和 Monaco 浏览器入口加载错误，修复后重新执行完整三轮，没有提高期限。

## 扩展配置隔离探针

入口为 `scripts/profile-extension-configuration.cjs`，使用镜像内实际编译的扩展配置服务。每次独立容器限制 1 CPU / 512 MiB、禁用网络；Node 显式 GC，2,001 个配置键，持有 80 份经过嵌套修改和序列化的小配置副本，并核对其他读取不受影响。每种三轮，顺序交替。

| 指标       | 原实现中位数 | 优化后中位数 |
| ---------- | -----------: | -----------: |
| 保留堆增量 |   23.311 MiB |    0.071 MiB |
| RSS 增量   |   44.922 MiB |    0.000 MiB |
| 探针耗时   |   1,840.3 ms |       6.2 ms |

优化后单轮堆或 RSS 增量可以略为负数，这是基线与 GC 的测量噪声，原值保留。上述 RSS 是隔离进程的增量，不是扩展宿主的实际总占用。

## 五人对照方法

基线镜像已经包含本轮启动、依赖、高亮取消、补全文档竞态和协同事务原子性修复；优化镜像在此基础上增加配置副本优化和 TypeScript 单服务默认值。两份源码的共同提交为 `b995efa51`，基线只把配置服务和默认设置两个文件恢复为 `51969304a` 的原字节。因此完整内存表只比较这两项内存改动，不能把共同可靠性修复的收益也归入该降幅。镜像均在 Linux ARM64 中实际执行冻结安装、`pnpm build:all`、扩展下载、清单生成和入口校验。Node 均为 24.16.0，70 个扩展包保持同一套固定版本。

每个版本各三轮，每轮使用新账户、项目与开发机，同时覆盖五人共享一个工作区、五人各自独立工作区。轮内顺序为基线/优化、优化/基线、基线/优化；同一套探针在开始和结束检查摘要。

正式运行复用完成协议诊断后的专属 DinD 镜像缓存，开始前核对已无诊断沙箱及持久卷，清理了本轮镜像 `/data` 声明产生的五个无引用空匿名卷。正常镜像没有 `TSS_LOG`；带日志诊断的六十份样本不进入对照。全部正式轮次结束后才恢复外层清理包装器并销毁该专属 daemon。上海时间 2026-10-25 23:41 的实际查询确认容器、数据卷、网络、Docker context 和临时升级镜像均不存在；实际清理凭据按原字节保存在正式对照目录。

每轮每种场景预热 30 秒、采集 30 份样本，共计每版 180 份、两版 360 份。每台开发机限制 4 CPU / 4 GiB；独立场景的数值是五台之和。夹具包含 100 个小型辅助 TypeScript 文件、协同文件、语言功能文件和 README，其中八个文件包含固定搜索词。

采样测量完成上述操作后的驻留状态，期间不持续注入编辑、构建或 AI 请求；这不是五人持续重负载的吞吐压力测试。

独立场景复用本轮 Alice 的开发机，另外四台为新建环境。容器历史峰值和累计限流可能包含前一阶段，采样区间内的实际内存和 CPU 差分单独统计。每份采样核对语言服务拓扑：基线十个 tsserver，优化后五个；发生 OOM 分配失败或进程被杀时不能将该轮标记为容量通过。

浏览器真实验证以下能力后才采样：五账户认证与权限、同源 Monaco Worker、函数补全及插入、类型错误的真实诊断文本、精确搜索 8 个结果/8 个文件、Quick Open 键盘确认、终端磁盘回执、并发编辑保存、撤销重做、离线重连、刷新、在线撤权，以及活跃浏览器下停止共享和独立 Server 并检查采样进程退出。每页先完成实际终端连接和命令回执，再执行语义与导航测量；Quick Open 在回车前核对首个实际结果的精确文件名，之后核对选中标签与全文。每个版本首次运行六阶段控制面回归。

RSS 是 IDE 根进程及其后代的驻留页合计，可能重复计算共享页；PSS 按共享比例分摊；容器 `memory.current` 包括该容器其他进程与文件缓存。三者分别呈现，不混为同一个指标。容器历史峰值之和不是五台同时出现的峰值。CPU 使用差分计数，一个逻辑核为 100%，包含采样开销。UI 延迟包含实际键盘、渲染与探针校验，不等同于语言服务内部响应耗时。

Docker VM 存在交换空间使用，不能根据全局 swap 推断受测容器的换页量。另从父 daemon 的 cgroup 只读观察各测试容器的当前与历史交换峰值，不在受测容器创建额外采样进程。该观察在第一轮共享采样结束后启动，早期阶段另保留历史峰值快照；不能把旁路轮询当成所有样本的同步 swap 字段。驻留内存与交换空间分开解释，文件缓存的 cgroup 归属也不能等同于整台主机的物理占用。

本机为 10 逻辑核、64 GiB，Docker VM 约 7.75 GiB，测试期间还有其他项目运行。逐份记录主机负载、容器限流和 OOM；高负载结果不能自动作为安静主机或默认 2 GiB 配置的稳定容量保证。大型仓库、其他语言、五人同时使用 AI、Windows 和真实 Kubernetes 仍需各自验收。

## 构建与回归

最终生产源码的 Node 全量为 140 个套件、1,496 项通过，29 项跳过，6 份快照通过；jsdom 为 353 个套件、3,297 项通过，28 项跳过，7 份快照通过。共 4,793 项通过、57 项既有跳过、13 份快照通过；源码宿主的原 15 秒启动检查已通过，没有延长期限或跳过该用例。

运行时构建和公开包消费检查 69 项、工作台 41 项、采样与报告等原生检查 33 项通过。新增补全生命周期 10 项与已有语言桥接 30 项一起通过。最终本地完整构建、两套 Linux 镜像完整构建及其产物摘要检查通过；逐份验证 70 个扩展入口和 18 份本地化清单，并确认两套编译后的补全实现相同。产品结构、架构、工作区依赖范围和脚本类型检查通过。架构门禁记录 66 个包、528 条内部依赖边，无遗留基线深层导入。

## 重跑与证据

镜像标签为本地验收产物，实际摘要保存在配套 JSON。先准备两份固定共同版本的隔离源码，基础镜像入口见[运行说明](RUNNING.md#node-镜像与隔离验收)：

```sh
set -eu
profile_root=$(mktemp -d)
git worktree add --detach "$profile_root/baseline" b995efa51
git worktree add --detach "$profile_root/optimized" b995efa51
git show 51969304a:packages/extension/src/hosted/api/vscode/ext.host.preference.ts \
  > "$profile_root/baseline/packages/extension/src/hosted/api/vscode/ext.host.preference.ts"
git show 51969304a:application/runtime/default-settings.json \
  > "$profile_root/baseline/application/runtime/default-settings.json"
pnpm -C "$profile_root/optimized" install --frozen-lockfile
pnpm -C "$profile_root/optimized" build:all
cd "$profile_root/optimized"
docker build --platform linux/arm64 -t opensumi-webide-node:memory-base .
docker build --platform linux/arm64 -f application/runtime/Dockerfile \
  --build-arg OPENSUMI_BASE=opensumi-webide-node:memory-base \
  -t opensumi-webide-workspace:dev .
```

将以下配方保存为 `$profile_root/Dockerfile.memory`，两版使用同一个基础镜像。现场复用了本机 R2 基底，其 ID 与最终两版 ID 一并留存；重新构建基础镜像后应重新采样。

```dockerfile
ARG BASE=opensumi-webide-workspace:dev
FROM ${BASE}
WORKDIR /app
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV PATH=/app/node_modules/.bin:${PATH} NODE_USE_ENV_PROXY=1
COPY . .
RUN --mount=type=cache,id=webide-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm build:all
RUN --mount=type=cache,id=webide-extensions,target=/app/.cache/extension-downloads \
    pnpm download-extension \
    && node scripts/build-extension-manifest.cjs tools/extensions builtin-extensions.manifest.json \
    && node scripts/verify-extensions.cjs
RUN node node_modules/tsx/dist/cli.mjs --eval "import { runtimeFingerprint } from './application/server/runtime/fingerprint.ts'; import { writeFile } from 'node:fs/promises'; runtimeFingerprint(process.cwd()).then(value => writeFile('.runtime-fingerprint', value));"
COPY application/runtime/default-settings.json /opt/opensumi/default-settings.json
```

```sh
docker build --platform linux/arm64 -f "$profile_root/Dockerfile.memory" \
  -t opensumi-webide-workspace:memory-baseline-r3-20261025 "$profile_root/baseline"
docker build --platform linux/arm64 -f "$profile_root/Dockerfile.memory" \
  -t opensumi-webide-workspace:memory-optimized-r3-20261025 "$profile_root/optimized"
```

随后运行完整对照；入口创建新的专属 daemon，正式运行的先后顺序与本次相同：

```sh
WEBIDE_ACCEPTANCE_SUITE=collaboration \
WEBIDE_ACCEPTANCE_PLATFORM=linux/arm64 \
WEBIDE_ACCEPTANCE_IMAGE=opensumi-webide-workspace:memory-baseline-r3-20261025 \
WEBIDE_ACCEPTANCE_COMPARE_IMAGE=opensumi-webide-workspace:memory-optimized-r3-20261025 \
WEBIDE_ACCEPTANCE_COMPARISON_ROUNDS=3 \
WEBIDE_ACCEPTANCE_COMPARISON_OUTPUT=output/runtime-profiles/runtime-memory-20261025/comparison \
WEBIDE_ACCEPTANCE_EVIDENCE_DIR=output/runtime-profiles/runtime-memory-20261025/comparison/cleanup \
bash scripts/run-local-sandbox-acceptance.sh

node scripts/summarize-collaboration-comparison.cjs \
  output/runtime-profiles/runtime-memory-20261025/comparison
```

入口拥有本轮独立 DinD、随机回环端口与临时卷，不切换默认 Docker context。外层清理后重新查询 daemon，验证专属容器、卷、网络、context 和临时升级镜像确实不存在；查询失败不能解释为已回收。汇总器拒绝失败、不完整、探针变化或未回收的结果。

完整原始结果、浏览器截图、进程命令和早期失败保存在忽略目录 `output/runtime-profiles/runtime-memory-20261025/`。调试轮次不参与正式三轮统计。无标准输入的首批隔离探针空输出也保留并排除。

可移植的完整分轮内存、CPU、延迟、进程拓扑、镜像与探针摘要、清理结果及原始证据索引摘要见[验收 JSON](runtime-memory-acceptance-20261025.json)。正式运行时间为上海时间 2026-10-25 22:44 至 23:40，外层清理于 23:41 通过。

冻结后的 `proof-index.json` 收录 422 个原始证据文件，已逐份复核字节数和 SHA-256；索引自身 SHA-256 为 `ac8492b7c79dd6a47ad38729477d5c81267da3c73f75b4fad5d32ea46776a58c`。临时构建 worktree 与索引自身不纳入递归清单，原始日志和凭据不进入 Git。

## 保留的失败与修正

| 记录 | 实际结果 | 修正与统计处理 |
| --- | --- | --- |
| 源码加载器接入早期 | 根目录配置错误、浏览器入口误加载 | 修复后重新运行完整三轮加载器对照；早期失败保留 |
| 浏览器预检轮次 | 文件树虚拟滚动、同名 Quick Open 标签、原生输入与旧诊断干扰，未形成完整采样 | 改为选择真实结果并核对完整文档、目标语义诊断；这些轮次排除 |
| `baseline-debug/attempt-1` | 30 份共享样本；16 次未处理取消异常，独立保存核对超时，整轮失败 | 修复 Monaco 延迟任务拒绝；磁盘读取改为原始字节；样本排除 |
| 第一次正式尝试 | 两场景全部功能步骤与 60 份采样完成，但出现 12 次补全文档行号异常，整轮失败 | 修复初始补全请求的版本竞态并保持列表详情复用；整组重跑，不混入旧样本 |
| 第二次正式尝试 | 共享场景完成 30 份采样，独立场景第三人的 Quick Open 超时；截图中弹层已关闭，非预期浏览器错误为 0 | 探针显式聚焦编辑器，仅在弹层关闭时记录并重开，保留总期限与实际文件断言；关闭原因未确定，整组重跑 |
| 第三次正式尝试 | 基线完整 60 份通过；优化版共享 30 份通过，独立场景第一人的结果点击时弹层消失，整组失败 | 改为每页先完成终端连接与真实回执，再验证语义与导航；首个目标文件结果使用键盘确认，最终仍核对选中标签和全文。鼠标关闭原因仍未确定，旧样本全部排除 |
| 第四次正式尝试 | 新增的单结果断言错误：最近打开与文件搜索同时展示同一目标文件；没有采样 | 改为回车前核对首个实际可选项的精确文件名，仍检查选中标签与全文；保留截图和零样本失败记录 |
| 第五次正式尝试 | 共享场景 30 份采样和活跃停止通过；重连后的 Dave 页面 60 秒内未返回函数补全，仍显示语言功能初始化；整轮失败 | 进程存活，容器 OOM 为 0。独立原生协议探针的五个语义服务在约 5.8–5.9 秒返回函数补全，继续收集真实页面协议日志；不能仅凭截图断言进程没有启动，旧样本排除 |
| 临时镜像重建 | 继承的扩展目录与本机生成的本地化清单不匹配 | 用干净源码、固定下载清单重新生成；核对全部入口及 18 份清单中的实际路径 |

命令输出探针实测 `WEBIDE_STDOUT_FRAMING\n` 经本轮远程命令接口返回后缺少末尾 LF。因此保存检查使用可逆编码传输文件原字节，保持末尾换行断言；修正后的独立五人保存已通过。失败轮次的浏览器、磁盘与资源快照和清理凭据一并保留。

额外带 `TSS_LOG` 的旧 R2 页面诊断完成 60 份采样及全部功能步骤，非预期浏览器错误为 0；最终协议收集器出现错误，五份收集文件不完整，缺失状态单独保留，不能冒充完整协议证据或并入正式内存数据。之后修复收集器并补充真实 Monaco/Yjs 的事务原子性回归，确认原实现向监听者暴露多次中间状态。该独立缺陷有修复前后对照，但没有证明它就是第五次尝试偶发 60 秒补全超时的根因。最终两套共同包含该修复的 R3 镜像重新执行完整六轮，未复现该超时。

2026-10-03 的 120/180 份未完成验收继续保留在[历史记录](collaboration-acceptance-20261003.json)。本轮新增了语义功能探针及可靠性修复，应使用本轮新基线比较，不能直接与历史 4.26/5.08 GiB 相减。
