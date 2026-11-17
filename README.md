# dsh-codebase-memory-cli

这是 codebase-memory CLI 的 DSH 插件。目标程序是个命令行程序，不是 MCP 服务器：插件拉起子进程、解析它输出的 JSON，再把其中精选的一小部分注册成 agent 能调的工具。

设计上围绕两件事。

## 1. 索引始终是最新的

每次读图之前先跑一次索引。CLI 的 `index` 调用本身是增量的，重抽哪些文件由它自己判断，所以它就是正确性的边界：一个回答不可能来自比这次调用更旧的图。这里没有新鲜度判据要猜，也没有变更集要拼。「文件从没提交过、索引时还在、后来被删掉」这类情形也不用单开一条分支。

代价是实打实测出来的，仓库 9.5k 节点、39k 条边：

| 场景 | `index` 耗时 |
|---|---|
| 干净树，没改过东西 | ~3.3 s |
| 改过一个文件 | ~4.1 s |
| 同一棵树加 `--mode fast` | ~4.3 s |

树没变不会更快，因为扫描本身就是全量遍历；`fast` 也不比 `full` 省。等于每次读多花约 3.5 秒，换一个永不陈旧的答案。

不想要这个代价，就把 `refreshBeforeRead` 设成 `false`：读图直接用现有索引，刷新只剩 `codebase_index` 一条路。

同一个工程并发读时共用一次扫描，不会排队再跑一遍。

## 2. 只暴露一部分工具

`surface: 'core'`（默认）注册六个工具。把 CLI 的操作目录整个铺成工具，光 schema 就要吃掉好几倍的系统提示词。

| 工具 | CLI 操作 | 回答什么 |
|---|---|---|
| `codebase_projects` | `list_projects` | 有哪些图，根目录在哪 |
| `codebase_status` | `index_status` | 节点数、边数、`indexed_at`、解析失败情况 |
| `codebase_index` | `index_repository` | 按工作树建图或刷新图 |
| `codebase_search` | `search_graph` | 某个概念或名字落在哪 |
| `codebase_snippet` | `get_code_snippet` | 一个符号在索引里的确切源码 |
| `codebase_trace` | `trace_path` | 谁调它、它调谁、影响面多大 |

`surface: 'full'` 再加 `codebase_coverage`（`check_index_coverage`）。`surface: 'gateway'` 只注册一个 `codebase_memory`：它列出二进制里的全部操作，再按 `{tool, args}` 转发过去，没有哪个操作会够不着。

`expose` 用一份显式名单顶掉默认选择，写短名（`search`、`trace`……）或注册后的工具名（`codebase_search`……）都认。

## 两种命令形态

同一台机器上可能装着两种 CLI，插件两种都会说：

| `commandStyle` | 实际执行 |
|---|---|
| `canonical` | `<exe> search --query X --json`，CLI-first 那个 fork |
| `compat` | `<exe> cli --quiet search_graph --format json --query X`，旧版二进制 |
| `auto`（默认） | `--version` 里出现 `codebase-memory-cli` 就走 canonical，否则 compat |

canonical 调用被二进制拒掉时，插件降级到 compat 重试一次并记日志，所以换二进制不用改设置。`exePath` 是个裸名字、PATH 上又找不到时，会退到 `codebase-memory-mcp`。

## 设置项

字段都在 **设置 → 插件 → codebase-memory-cli** 这一行上；改完保存，插件重启。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `surface` | `core` | `core` / `full` / `gateway` |
| `expose` | `[]` | 显式工具名；非空时顶掉默认集合 |
| `exePath` | `codebase-memory-cli` | 二进制名或绝对路径 |
| `commandStyle` | `auto` | `auto` / `canonical` / `compat` |
| `cwd` | `''` | 工作目录；留空用会话工作区 |
| `env` | `{}` | 额外环境变量，例如 `CBM_CACHE_DIR`、`CBM_RUNTIME_DIR` |
| `defaultProject` | `''` | 调用没给 `project` 时用哪个工程 |
| `refreshBeforeRead` | `true` | 每次读图前先跑一次增量索引 |
| `indexMode` | `full` | 刷新时用的索引模式，可选 `moderate`、`fast` |
| `persistence` | `false` | 顺带写 `.codebase-memory/graph.db.zst` |
| `daemon` | `true` | 插件加载时跑一次 `daemon start` |
| `toolCallTimeoutMs` | `120000` | 单次读的超时 |
| `indexTimeoutMs` | `600000` | 单次刷新的超时 |
| `enabled` | `true` | 是否注册这些工具 |

## 与本机其他安装共存

机器上跑着别的版本的 daemon 时，CLI 会拒绝启动，这是它的版本 cohort 检查。两套安装因此各要一份独立的协调目录。插件自带的 patch 里已经隔开：

```yaml
env:
  CBM_CACHE_DIR: '…/codebase-memory-cli-data/cache'
  CBM_RUNTIME_DIR: '…/codebase-memory-cli-data/runtime'
```

想和本机其他 codebase-memory 客户端共用一个 daemon、一份图，就把这两项改掉或清空。

## 已验证的行为与限制

验证环境：Windows，`codebase-memory-cli dev`（build `e613dc9d9b4a…`），仓库是 9.5k 节点的 Rust 工程。

- `projects`、`status`、`search`、`snippet`、`trace`、`coverage` 在两种命令形态下都返回 payload JSON。同一个查询分别走 canonical 和 compat，结果逐字节相同。
- `codebase_index` 跑了 6.2 秒，报 `nodes: 9523 edges: 39481`。这组数字是跑完之后再读一次 `index_status` 拿到的。
- 单次 `index .`：干净树 3.3 秒，改一个文件后 4.1 秒，加 `--mode fast` 4.3 秒。`refreshBeforeRead` 这个取舍就是按这组数字定的。
- `surface: core` 注册 6 个工具，schema 5.6 kB；`full` 7 个，6.5 kB；`gateway` 1 个，能列出全部 17 个操作并按 `{tool, args}` 转发。
- `--version` 报的是 `codebase-memory-cli dev`，所以 `commandStyle: auto` 判成了 canonical。

限制：

- 每次读都付一次全量扫描。这是设计本身，不是漏了优化；要退出用 `refreshBeforeRead: false`。
- `index_repository` 没有 `--format`，`codebase_index` 的结果是跑完再读一次 `index_status` 得来的。
- `codebase_status` 报的是索引现在的样子，不做刷新，所以很便宜。它答的是索引里现在有什么，不替你算本该有什么。
- `gateway` 转发时把 `format: "json"` 写进临时 args 文件，因为 `--args-file` 会盖掉所有命令行参数。

## 安装

在 **插件 → 添加插件** 里选包目录，或者：

```sh
dsh plugin --profile <profile> add <absolute package directory>
```
