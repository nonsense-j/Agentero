# 用 MCP 连接外部 Agent

设置里打开 **MCP server** 后，本机外部客户端（Claude Code、Codex、Cursor、MCP Inspector 等）可以直接通过 loopback HTTP MCP（`http://127.0.0.1:8765/mcp`）调用本地 Vault 的论文库（列表、入库、写 NOTES、移动/删除文件），无需把 MCP 暴露到公网。默认操作当前打开的 Vault；先用 `vault_list` 可查看并切换到其它打开过的本地 Vault。

桌面路径下应用必须保持运行。无桌面的服务器可用 `agentero mcp serve`（见文末），不必打开桌面端。应用内 Agent 面板走 ACP（[接入 Agent](agents.md)）；本篇面向 **外部** MCP 客户端。协议与工具表详见 [backend/mcp.md](../backend/mcp.md)。

## 1. 打开本机 MCP

1. 打开一个**本地** Vault。
2. 在 **Settings → General → MCP server** 打开开关。默认地址 `http://127.0.0.1:8765/mcp`；端口旁绿点表示正在监听。
3. 点击客户端配置复制按钮或直接把 `http://127.0.0.1:8765/mcp` 填入外部 MCP 客户端（Streamable HTTP，无鉴权，仅监听 `127.0.0.1`）。

外部 Agent 保存图片等二进制文件时，使用 `file_write`，把文件编码成标准 Base64 放进 `content`，并传 `encoding: "base64"` 和 Vault 相对 `path`（例如 `assets/figure.png`）。不带 `data:` 前缀；仅支持替换，覆盖前需确认，解码后最多 2 MiB。普通文本写入无需传 `encoding`，仍支持追加；`file_read` 仍只读文本。

## 2. 能做什么

- `paper_list` / `paper_get` — 论文 metadata（list 默认瘦字段；`fields` / `full` 按需）
- `paper_set_read` — 标记已读/未读
- `paper_set_meta` — 更新论文元数据（所属会议/期刊、标题、日期、DOI 等）
- `import_id` — arXiv / DOI / URL 入库
- `paper_notes_get` / `paper_notes_write` — 读写该篇 `NOTES.md`
- `paper_tag_add` / `paper_tag_rm` / `paper_tag_set` / `paper_tag_list` — 标签管理
- `layout_list` / `layout_get` / `page_read` — 侧栏图/表/公式索引与按页正文（需先在桌面端完成云端版面分析）
- `vault_search {"query":"transformer attention","limit":10}` — 只读全库 Markdown 与科研表格关键词 AND 搜索。返回相对 path、snippet、1-based line 和 truncated；用 `file_read {"path": hit.path}` 回读定位
- `file_list` / `file_read` / `file_write` / `file_move` / `file_delete` — 读改 Vault 内文件；不碰 `.agentero`、PDF 二进制和 `NOTES.md`（笔记仍用 `paper_notes_write`）
- Resources：`agentero://vault`、`agentero://agent-invariants`、`agentero://skills/agentero-cli`

## 3. 无桌面服务器（Headless CLI）

文献库在 Linux 服务器上时，可在服务器上前台启动同一套本机 loopback MCP：

```sh
agentero mcp serve --vault /path/to/vault --listen 127.0.0.1:8765
```

客户端与进程在同一台机器上时，直接连接 `http://127.0.0.1:8765/mcp`；远程机器上的客户端可经由本地端口转发连接。需要允许客户端读取 PDF 正文时加上 `--expose-paper-text`。不要将端口暴露到公网：服务不带鉴权，只设计用于本机 loopback。
