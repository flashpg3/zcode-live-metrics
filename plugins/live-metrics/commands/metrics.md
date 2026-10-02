---
description: 实时指标速查（速度 / 缓存 / 上下文）
---

通过 live-metrics 的 MCP 工具查询 ZCode 实时运行指标，并整理为紧凑的中文摘要。

参数（`$ARGUMENTS`）：
- 无参数或 `summary`：调用 `metrics_summary`，将文本结果原样输出，不要改写数字。
- `snapshot`：调用 `metrics_snapshot`，整理成表格：速度（单次/生成吞吐/会话强度）、缓存命中率（累计/60s/最近一次）、累计 token、模型拆分、最近调用。
- `dashboard`：调用 `open_dashboard`，并告知面板地址。

注意：生成中显示的速度是「上次实测值」，需如实注明；所有数字必须与工具返回一致，不得估算。
