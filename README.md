# DevSpace（Fast Tools 增强版）

基于 [DevSpace](https://github.com/Waishnav/devspace) 的 MCP 性能增强方案，目标是在保留 DevSpace OAuth、Workspace、安全边界和完整 Coding 能力的前提下，显著减少 ChatGPT 与本地电脑之间的 MCP Tool Call 次数。

本项目主要解决一个实际问题：DevSpace 在复杂开发任务中非常完整，但一些简单操作通常需要先 `open_workspace`，再执行读取、搜索、Git 或修改工具。通过公网 MCP 使用时，每多一次 Tool Call 都可能增加数百毫秒到数秒的网络往返和模型二次规划时间。

本项目为高频操作增加了一组“一次调用完成”的 Fast Tools，并保留原版 DevSpace 作为复杂任务的后备能力。

## 架构

```text
ChatGPT
   ↓
Custom MCP / OAuth
   ↓
Cloudflare Tunnel（可选）
   ↓
DevSpace MCP Server
   ↓
Fast Tools + 原生 Workspace Tools
   ↓
本地项目目录
```

当前增强补丁针对：

```text
@waishnav/devspace 1.1.0-beta.4
```

项目不会把 `node_modules`、本地 Runtime、OAuth Token、DevSpace 用户配置或 Cloudflare 凭据提交到 Git。

## 相比原版 DevSpace 的主要增强

### 1. 减少 MCP 调用次数

原版简单任务可能是：

```text
open_workspace
→ read / exec_command / apply_patch
→ show_changes
```

本项目会优先走：

```text
project_snapshot_fast
read_file_fast
project_search_fast
multi_edit_fast
...
```

很多任务可以从 3～5 次 MCP 调用压缩到 1 次。

### 2. 减少模型二次规划

DevSpace Server Instructions 已调整为“优先使用最少的 MCP 调用”。

例如查看一个陌生项目时，模型会优先调用 `project_snapshot_fast`，一次获取目录、Git 状态和常见项目文件，而不是连续调用多个工具。

### 3. 保留 DevSpace 原生能力

Fast Tools 只处理高频、明确、风险可控的任务。

复杂重构、Worktree、任意 Shell、长时间进程和完整 Diff 仍然使用 DevSpace 原生工具，因此不会为了速度牺牲开发能力。

## Fast Tools

| Tool | 功能 |
|---|---|
| `list_directory_fast` | 单次列出目录 |
| `read_file_fast` | 单次读取文本文件 |
| `search_files_fast` | 使用 ripgrep 搜索单个关键词 |
| `git_status_fast` | 返回 Git branch/status |
| `edit_file_fast` | 单文件精确文本替换 |
| `write_file_fast` | 创建或显式覆盖小型文本文件 |
| `multi_read_fast` | 一次读取多个文件 |
| `project_snapshot_fast` | 一次返回目录、Git 和常见项目文件 |
| `project_search_fast` | 一次搜索多个关键词 |
| `git_summary_fast` | branch/status/diff stat/changed files/recent commits |
| `multi_edit_fast` | 跨文件批量精确修改，先全部验证再写入 |
| `run_checks_fast` | 一次运行 Git/Test/Lint/Pytest/Python Compile 检查 |

### 批量修改安全机制

`multi_edit_fast` 不会“改一个算一个”。

它会先检查所有目标文件的 realpath、安全边界和匹配次数；只有全部验证成功后才开始写入。如果写入过程中发生异常，会尝试回滚已经写入的文件。

## 性能参考

以下数据来自一台 Windows 主机通过 Cloudflare Tunnel 使用 MCP 的实测，仅作为参考，实际结果与网络和 Cloudflare Edge 有关。

| MCP 往返次数 | 平均耗时 |
|---:|---:|
| 1 次 | ~0.72 秒 |
| 3 次 | ~2.92 秒 |
| 5 次 | ~4.42 秒 |

因此类似“查看项目结构 + README + package.json + Git 状态”的任务，从约 5 次调用压缩成 1 次时，网络层可减少约 3～4 秒。

## 仓库结构

```text
devspace/
├─ app/
│  ├─ package.json
│  └─ package-lock.json
├─ patches/
│  └─ devspace-1.1.0-beta.4/
│     └─ server.js
├─ scripts/
│  ├─ apply-fast-tools.mjs
│  └─ verify-fast-tools.mjs
├─ .gitignore
├─ install.bat
├─ start-devspace.bat
└─ README.md
```

以下内容属于本地运行环境，不会提交：

```text
app/node_modules/
runtime/
fast-tools-backup/
.devspace/
auth.json
config.jsonc
.env*
Cloudflare credentials
证书 / 私钥
日志 / SQLite / 缓存
```

## 环境要求

核心要求：

- Node.js >= 22.19 且 < 27
- npm
- Git
- ripgrep（`rg`）

可选：

- Python 3：仅 `pytest` 和 `python_compile` 检查需要
- Cloudflare Tunnel：需要从公网连接本机 MCP 时使用

## 安装

### Windows

Clone 仓库后运行：

```bat
install.bat
```

该脚本会：

1. 检查 Node/npm/Git/ripgrep。
2. 在 `app` 中安装固定版本的 DevSpace。
3. 根据 DevSpace 版本寻找对应补丁。
4. 应用 Fast Tools。
5. 验证 12 个 Fast Tools 是否全部存在。

也可以手动执行：

```bat
cd app
npm install
cd ..
node scripts\apply-fast-tools.mjs
node scripts\verify-fast-tools.mjs
```

启动：

```bat
start-devspace.bat
```

如果本地存在 `runtime/node-v22.23.2-win-x64`，启动脚本会优先使用它；否则使用系统 PATH 中的 Node.js。

## DevSpace 配置

OAuth、Owner Password、allowedRoots、publicBaseUrl 等仍然使用 DevSpace 自己的配置机制。

这些配置属于机器本地环境，不应该提交到 GitHub。尤其不要提交：

- Owner Password
- OAuth Access / Refresh Token
- `auth.json`
- Cloudflare Tunnel Token
- API Key
- 私钥或证书

## 推荐使用方式

简单任务优先 Fast Tools：

```text
了解项目       → project_snapshot_fast
多个文件       → multi_read_fast
单关键词搜索   → search_files_fast
多关键词搜索   → project_search_fast
Git 总览       → git_summary_fast
单文件修改     → edit_file_fast
多文件修改     → multi_edit_fast
创建文件       → write_file_fast
统一验证       → run_checks_fast
```

复杂开发继续使用：

```text
open_workspace
→ read
→ apply_patch
→ exec_command
→ show_changes
```

## 搜索优化

`search_files_fast` 和 `project_search_fast` 使用 ripgrep，并默认排除常见大型生成目录：

```text
node_modules
.git
.venv
venv
__pycache__
.next
dist
build
```

这样在中大型代码库中比逐文件读取更适合交互式 MCP 场景。

## 跨平台

Fast Tools 会根据操作系统从 PATH 解析：

```text
git / git.exe
rg / rg.exe
npm / npm.cmd
python3 / python.exe
```

Windows 是当前主要测试平台；Linux/macOS 建议自行执行完整测试后再用于生产环境。

## 升级 DevSpace

不要直接把旧补丁覆盖到新的 DevSpace 版本。

`apply-fast-tools.mjs` 会读取实际安装的 DevSpace 版本，并且只有存在：

```text
patches/devspace-<version>/server.js
```

时才允许覆盖。

例如升级到新版本后，如果仓库还没有对应目录，脚本会主动停止并要求重新做兼容性检查。

推荐流程：

1. 更新 DevSpace 版本。
2. 对比上游 `dist/server.js` 的变化。
3. 重新移植 Fast Tools。
4. 完成功能和性能测试。
5. 新建对应的 `patches/devspace-x.y.z/`。
6. 再允许部署。

## 安全设计

- Fast Tools 仍通过 DevSpace Workspace / allowedRoots 做安全边界校验。
- 文件操作使用 realpath 检查，降低路径穿越和软链接越界风险。
- `write_file_fast` 默认不覆盖已存在文件。
- `edit_file_fast` / `multi_edit_fast` 要求精确匹配数量。
- `run_checks_fast` 只允许预定义检查项，不接受任意 Shell 字符串。
- OAuth 保持开启，不建议为了性能关闭认证。
- GitHub 仓库通过 `.gitignore` 排除本地凭据和运行状态。

## 与上游项目的关系

本项目基于 DevSpace 的 MIT 版本进行增强，DevSpace 原项目：

https://github.com/Waishnav/devspace

本仓库不是 DevSpace 官方项目。Fast Tools 补丁目前针对特定 DevSpace 版本维护，升级前必须重新验证兼容性。

## 已知依赖风险

截至 2026-09-18，对 `app` 执行 `npm audit --omit=dev` 时，上游 DevSpace 的间接依赖会报告安全公告，主要来自：

- `@earendil-works/pi-coding-agent`
- `undici`
- `brace-expansion`
- `protobufjs`

其中部分问题可以由未来的依赖更新解决，但当前 `undici` 项在 npm audit 中没有可直接应用的修复。

因此建议：

1. 不要把 DevSpace 的本地端口直接裸露到公网。
2. 保持 OAuth 开启。
3. 使用 `allowedRoots` 将可访问目录限制到最小范围。
4. 使用 Cloudflare Tunnel 或其他受控反向代理。
5. 定期执行 `npm audit`，升级 DevSpace 后重新验证 Fast Tools 补丁兼容性。

## 第三方许可

本仓库的版本化 `server.js` 补丁基于 MIT License 的 DevSpace 文件修改。

上游许可证副本保存在：

```text
THIRD_PARTY_LICENSES/DevSpace-MIT.txt
```