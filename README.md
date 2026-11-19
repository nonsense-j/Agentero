<p align="center">
  <img src="docs/assets/hero.png" alt="Agentero" width="100%" />
</p>

<h3 align="center">聚焦科研阅读、论文发现与 Agent 协作的本地优先桌面工作台</h3>

<p align="center">
  基于 <a href="https://github.com/poco-ai/Agentero"><b>poco-ai/Agentero</b></a> 深度裁剪与局部重设计的分叉版本：保留人类舒适的 PDF 阅读与双链笔记体验，强化论文池发现、引文谱系、综述生成与 CARSI 机构访问，保持轻量纯粹与完全本地存储。
</p>

<p align="center">
  <b>中文</b> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/nonsense-j/Agentero/releases"><img alt="release" src="https://img.shields.io/github/v/release/nonsense-j/Agentero?include_prereleases&style=for-the-badge&logo=github&color=1B54E8&labelColor=20242D"></a>
  <a href="https://github.com/nonsense-j/Agentero/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/nonsense-j/Agentero?style=for-the-badge&logo=opensourceinitiative&logoColor=white&color=34D399&labelColor=20242D"></a>
  <a href="https://github.com/poco-ai/Agentero"><img alt="upstream" src="https://img.shields.io/badge/Upstream-poco--ai%2FAgentero-5319E7?style=for-the-badge&logo=github&logoColor=white&labelColor=20242D"></a>
</p>

> **致谢原项目**：本仓库是开源项目 **[poco-ai/Agentero](https://github.com/poco-ai/Agentero)** 的社区分叉版本。核心的本地优先 Vault/Catalog 架构、EmbedPDF 阅读与版面分析框架、Plate 双链 Markdown 编辑器、ACP 本地 Agent 与 MCP 服务基础均源自原版 Agentero 团队的卓越设计。我们定期通过选择性同步机制吸收上游的 Bug 修复与精选改进，衷心感谢原作者与所有上游贡献者！

---

## 与原版 Agentero 的区别

本分叉围绕「**本地优先、轻量聚焦、桌面端科研阅读与论文发现主线**」对原版进行了架构裁剪与核心能力重设计：

| 维度 | 原版 [poco-ai/Agentero](https://github.com/poco-ai/Agentero) | 本仓库（[nonsense-j/Agentero](https://github.com/nonsense-j/Agentero)） |
|---|---|---|
| **产品定位** | 全功能科研平台（覆盖阅读、LaTeX 写作编译、移动端、云服务、插件生态等） | 聚焦**桌面端科研阅读、论文发现、综述整理与 Agent 协作**的轻量本地工作台 |
| **广场（Plaza）与论文发现** | 侧重 Cool Papers / ModelScope / Papers with Code / RSS / arXiv 推荐等外部浏览流 | 基于本地 `collection.sqlite` 深度重写为五大原生面板：**Paper Collection**（28 顶会主轨 + arXiv 论文池、Seed 预热同步、LLM 关键词补全）、**Paper Discover**（快速检索 + 池内引文谱系图 + Deep Search）、**Paper Survey**（带引用 Related Work 与 HTML 综述报告生成）、**Paper Recommend**、**CCF Deadline** |
| **机构文献访问** | 通用机构代理网关（Institution Proxy Gateway）自动探测 | 内置高校 **CARSI 机构单点登录（SSO）** 与 WebView 会话探测，支持 IEEE / ACM 等出版商访问检测与登录后入库 |
| **子系统与依赖精简** | 包含 TeX/Writing 编译、iOS/Android 移动端与 Bridge、Remote Vault / SSH 隧道、账号与云额度、Word/知乎/遥测集成、PDF Reflow、本地布局模型资产、Tesseract OCR 等 | 全面裁剪上述非主线重型子系统与 Excalidraw 白板依赖（零账号绑定、零遥测上报、无重型原生 OCR/排版模型资产），保持仓库与安装包精简 |
| **交互与 UI 设计** | 持续演进 Zen 多会话工作区、离线词典、版面元素点选替代框选、全屏沉浸模式、评论栏弹出（Rail Peek）等新交互 | 以克制、稳定的阅读排版为主：统一打磨 PDF 边注与选区卡片视觉、Markdown 笔记排版、Streamdown 与 Deep Search 报告样式；保留传统框选视觉批注与固定边注槽位，并选择性吸收上游高价值小改进（如 400% 缩放、公式复制 LaTeX、引用预览展开、划词翻译卡外部点击关闭等） |
| **翻译与模型配置** | 移除 Google Translate / DeepLX，配套官方托管能力 | 保留 Google Translate / DeepLX 等零配置免费翻译源，同时强化 **OpenAI 兼容接口**（全文翻译并发数 1–8 可配置、3 字段精简关键词 LLM 配置与模型选择器） |
| **构建与发布流** | 全平台桌面 + 独立 CLI + iOS TestFlight + Homebrew Tap | 按平台拆分的轻量 GitHub Actions 桌面安装包构建（Windows x64 NSIS、macOS Apple Silicon & Intel，支持 Fork 无签名密钥直接构建） |

---

## 核心功能

### 1. 论文广场（Plaza）：论文池、深度检索与综述生成
- **Paper Collection（本地论文池）**：基于 `collection.sqlite` 维护 28 个官方顶会主轨与 arXiv 论文池，支持 GitHub Release Seed 预烘焙一键同步、增量后台刷新、同义词归一化检索与 OpenAlex / Semantic Scholar / LLM 关键词元数据补全。
- **Paper Discover（快速检索、引文图谱与 Deep Search）**：支持毫秒级 FTS5 本地快速检索、池内引用与被引谱系图可视化（Citation Lineage Graph），以及面向研究问题的多轮 Deep Search 深度检索报告。
- **Paper Survey（综述与 Related Work 生成）**：结合本地 Vault 文献、论文池与 `plaza_survey` MCP 工作流，自动抽取 TeX Introduction / 元数据并生成带准确引用标注的 Related Work 与可导出 HTML 综述报告。
- **Paper Recommend & CCF Deadline**：基于本地文献库特征的个性化论文推荐，以及按截稿时间整理的 CCF 会议列表。

### 2. 结构化 PDF 阅读、批注与双链笔记
- **PDF 阅读与标注**：基于 EmbedPDF 真实比例渲染，支持最高 **400% 缩放**、大纲导航、全文查找、平滑划词、多色高亮、页边评论卡片与**视觉区域框选批注**（针对图/表/算法/公式写备注或向 Agent 提问）。
- **版面分析与引用预览**：接入远程 / 自托管版面解析服务（Paddle / MinerU 4.1 / OpenAI 兼容），自动识别图、表、算法与编号公式；支持分组文本引用与本地参考文献解析，点击引用可展开本地文献详情预览，侧栏 Paper Info 支持 arXiv 与 DOI 一键直达。
- **多模式翻译**：支持划词翻译（可选开启点击外部自动关闭）、单页/双栏对照与全文版面翻译；保留免费免 Key 通道并支持 DeepL / Azure / Google Cloud / OpenAI 兼容（可配置 1–8 并发）/ Agent 翻译。
- **双链 Markdown 笔记**：内置 Plate 所见即所得编辑器，默认支持与 PDF 左右分屏联动（`⌘\` / `Ctrl+\` 切换并记忆栏宽）；支持 `[[双链]]`、Obsidian Callout、Mermaid 交互缩放视口、`==高亮==`（含中文邻接输入）与 `<u>下划线</u>`、单行 `$$`/`\[`/`\(` 与 `\tag` 块级公式渲染，以及**点击 / 右键直接复制渲染公式的 LaTeX 源码**。

<p align="center">
  <img src="docs/assets/agent.png" alt="PDF 阅读与 Agent 伴读" width="90%" />
  <br/>
  <sub>分屏阅读与分析：左侧 PDF 高亮批注，右侧本地 Agent 基于结构化上下文进行答疑与推导</sub>
</p>

<p align="center">
  <img src="docs/assets/translate.png" alt="划词翻译与笔记联动" width="90%" />
  <br/>
  <sub>划词翻译与笔记沉淀：阅读过程中提取的要点可直接整理至本地 Markdown 笔记</sub>
</p>

### 3. 开放 Agent 协议（ACP）与本地 MCP 服务
- **BYOA 本地 Agent（ACP）**：遵循 Agent Client Protocol，支持接入 Claude Code、Codex、OpenCode、Antigravity CLI（`agy` 支持官方安装器一键安装/更新/卸载）等本地 Agent，支持选区引用加入对话、页内 Quick Chat、结构化提问卡片、队列排队发送与权限控制，上下文完全保留在本地。
- **内置 MCP Server**：开启后在本地回环端口（默认 `127.0.0.1:8765/mcp`）提供 Streamable HTTP MCP 服务，供外部 AI 客户端直接检索文献库、读取笔记与触发入库。
- **Headless CLI（`agentero-cli`）**：提供无头命令行工具用于 Vault / Catalog 查询、论文标签管理、BibTeX 导入导出及论文池 Seed 烘焙与导入。

### 4. 机构访问、Zotero 兼容与透明本地存储
- **CARSI 机构认证与多途径入库**：支持 DOI / arXiv / 标题魔棒入库、PDF 拖拽入库、高校 CARSI 单点登录辅助下载，以及本地 `127.0.0.1:23119` Zotero Connector 浏览器扩展一键抓取。
- **Zotero 迁移与 BibTeX 互通**：支持导入本地 Zotero 数据库与导出 BibTeX / BibLaTeX。
- **纯文件透明存储与自主同步**：Vault 中的 PDF、Markdown 笔记、标注（`marks/`）、版面索引（`source/`）均以开放文件存放，结构化元数据存于 `.agentero/catalog.sqlite`，离开应用依然可由任意外部工具读写；支持通过 **S3 兼容对象存储 / WebDAV / Git** 进行多端自主同步（支持按嵌套论文目录配置同步作用域）。

---

## 快速开始

### 1. 下载桌面安装包（Windows / macOS）

前往本仓库的 **[GitHub Releases](https://github.com/nonsense-j/Agentero/releases)** 下载对应平台的预编译安装包：
- **Windows (x64)**：`*-setup.exe`（NSIS 安装包）
- **macOS (Apple Silicon)**：`*_aarch64.dmg`
- **macOS (Intel)**：`*_x64.dmg`

### 2. 从源码运行与构建

环境要求：Node.js 24+、pnpm、Rust Stable 工具链（Windows 需 MSVC Build Tools）。

```bash
# 安装前端依赖
pnpm install

# 启动桌面端开发模式（前端 + Rust Host）
pnpm tauri dev

# 构建桌面安装包
pnpm tauri build

# 可选：构建 Headless CLI
cargo build -p agentero-cli --release
```

更多架构与开发文档请参阅 [docs/architecture.md](docs/architecture.md)、[docs/frontend/](docs/frontend/index.md) 与 [docs/backend/](docs/backend/index.md)。

---

## 致谢

- **核心致谢 [poco-ai/Agentero](https://github.com/poco-ai/Agentero)**：感谢原版 Agentero 团队与社区贡献者打造了这套优秀的本地优先科研工作台底座与开放协议设计。本分叉在原仓库基础上进行精简定制与功能探索，并持续尊重与保留上游的开源协议与贡献记录。
- 感谢 Tauri、React、EmbedPDF、Plate、Dockview、shadcn/ui、Streamdown、OpenAlex、Semantic Scholar、CCF Deadlines 等开源项目与开放学术数据源。

## 开源许可证

本项目沿用原仓库的 [MIT License](LICENSE) 协议开源。第三方组件与许可证清单见 [.github/THIRD_PARTY_NOTICES.md](.github/THIRD_PARTY_NOTICES.md)。
