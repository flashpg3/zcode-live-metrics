# live-metrics · 开发者文档

本文件是 live-metrics 的实现说明：模块地图、跨进程契约、三节奏循环、开发与测试。

## 模块地图

```
plugins/live-metrics/
├── .zcode-plugin/plugin.json   插件清单（版本号单一来源，其余位置由契约测试断言同步）
├── .mcp.json                   MCP 声明：launch.sh + user_config 模板
├── server/
│   ├── main.mjs                入口分发：daemon | mcp
│   ├── config.mjs              配置、状态文件路径、userConfig 读取优先级
│   ├── adapt/                  ★ 宿主格式假设的唯一归宿（格式变更只改这里）
│   │   ├── tail.mjs            字节偏移尾读 + 严格换行分帧（StringDecoder 保 UTF-8）
│   │   ├── rollout.mjs         rollout 目录扫描 / model_io 行 → 样本
│   │   ├── hostlog.mjs         宿主事件日志 → 生成中状态 + 焦点信号
│   │   └── titles.mjs          sqlite 只读会话标题（失败静默降级）
│   ├── core/
│   │   ├── metrics.mjs         口径表纯函数
│   │   ├── sessions.mjs        会话存储（环形截断）与快照视图
│   │   └── focus.mjs           焦点状态机（跟随 + 防抖 + 钉住）
│   ├── daemon.mjs              单例接管、三节奏循环、生命周期规则
│   ├── http.mjs                回环 HTTP + 变更即推 SSE
│   ├── history.mjs             复扫 rollout 的按天/按会话聚合（无自建存储）
│   ├── window.mjs              悬浮窗编排（spawn/收养/30s 重开）
│   ├── summary.mjs             人读简报渲染（MCP 与 /metrics 共用）
│   ├── mcp.mjs                 薄代理：stdio JSON-RPC ↔ daemon HTTP
│   └── ui/                     面板前端（无构建，vanilla JS + SSE）
├── scripts/
│   ├── launch.sh               Node 探测启动器
│   ├── window.swift            macOS 原生悬浮窗（swift 解释执行）
│   └── sync-version.mjs        版本同步（改 plugin.json 后运行）
├── hooks/                      SessionStart/UserPromptSubmit/Stop → notify-session.sh
├── commands/metrics.md         /metrics 斜杠命令
└── test/                       node --test（契约 + 单元，31 例）
```

## 跨进程契约

| 文件（dataDir 下） | 写方 → 读方 | 内容 |
|---|---|---|
| `daemon.lock` | daemon 单例协议 | O_EXCL 抢锁；持锁者 pid + bootId；SIGTERM 接管 |
| `daemon.pid` | daemon → hooks/巡检 | 纯文本 pid（存活 + `ps` 命令行双重校验防 PID 复用） |
| `dashboard.json` | daemon → 悬浮窗/代理 | `{url, port, pid, bootId, version}`；窗口轮询此文件重载/自退 |
| `active-session.json` | hooks → daemon | 焦点锚点信号；**Stop 事件故意不写**（防后台任务拽走焦点） |
| `pinned-session.json` | 面板/悬浮窗 ↔ daemon | 钉住状态（daemon 重启后恢复） |
| `config.json` | MCP 代理 → daemon | userConfig 落盘，让 hook 拉起的 daemon 也能读到（修复旧版盲区） |

## 三节奏循环

| 节奏 | 职责 |
|---|---|
| 120ms | rollout + 宿主日志尾读 → 聚合 → 快照变更即推 SSE（R1 ≤200ms 上屏） |
| 1s | 焦点会话的会话强度环形采样（600 点 = 10 分钟，诚实含 0）+ 会话清理 |
| 10s / 30s | 悬浮窗探活重开、会话标题、dashboard.json 续签、空闲自退裁决、24h 硬上限 |

## 开发与测试

```bash
# 单元 + 契约测试（零依赖）
node --test

# 本地起 daemon（隔离数据目录，避免与已安装插件互相干扰）
ZCODE_METRICS_PLUGIN_DATA=/tmp/lm-dev ZCODE_METRICS_PORT=7746 \
  ZCODE_METRICS_FLOATING=false node server/main.mjs daemon

# MCP 裸调（stdio JSON-RPC）
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server/main.mjs
```

**改版本号**：只改 `.zcode-plugin/plugin.json`，然后 `node scripts/sync-version.mjs`；
契约测试会在两边漂移时失败。

## 已知边界

- 生成中的 token 流不存在于本机任何日志，速度位生成期间显示"上次实测"。
- Windows 不支持（hooks/MCP 硬编码 `/bin/bash`）。
- 模型上下文窗表是 best-effort，未知模型只显示绝对 token 数。
