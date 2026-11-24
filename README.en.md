<p align="center">
  <img src="docs/assets/agentero-app-icon.svg" alt="Dovero" width="112" />
</p>

<h1 align="center">Dovero</h1>

<h3 align="center">A Focused, Local-First Desktop Research Workbench for Paper Discovery, Reading & Agent Collaboration</h3>

<p align="center">
  Bringing the latest papers to your desk like an origami messenger dove — a streamlined, locally redesigned community fork of <a href="https://github.com/poco-ai/Agentero"><b>poco-ai/Agentero</b></a>: preserving comfortable PDF reading and bi-directional Markdown notes while expanding local Paper Collection discovery, citation lineage, survey generation, and CARSI institutional access — lean, zero-account, and 100% local-first.
</p>

<p align="center">
  <a href="README.md">中文</a> | <b>English</b>
</p>

<p align="center">
  <a href="https://github.com/nonsense-j/Dovero/releases"><img alt="release" src="https://img.shields.io/github/v/release/nonsense-j/Dovero?include_prereleases&style=for-the-badge&logo=github&color=1B54E8&labelColor=20242D"></a>
  <a href="https://github.com/nonsense-j/Dovero/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/nonsense-j/Dovero?style=for-the-badge&logo=opensourceinitiative&logoColor=white&color=34D399&labelColor=20242D"></a>
  <a href="https://github.com/poco-ai/Agentero"><img alt="upstream" src="https://img.shields.io/badge/Forked_from-poco--ai%2FAgentero-5319E7?style=for-the-badge&logo=github&logoColor=white&labelColor=20242D"></a>
</p>

> **Fork Notice & Acknowledgements**: **Dovero** is an independent community fork of **[poco-ai/Agentero](https://github.com/poco-ai/Agentero)** (not an official upstream distribution). The foundational local-first Vault/Catalog architecture, EmbedPDF viewer and layout-analysis pipeline, Plate bi-directional Markdown editor, ACP local agent client, and built-in MCP server all originate from the upstream Agentero team. We selectively sync upstream bug fixes and curated improvements — our sincere thanks to the original authors and all upstream contributors!

---

## Differences from Upstream Agentero

**Dovero** focuses on a **lean, local-first desktop paper discovery and scholarly reading workbench**, pruning non-core heavy subsystems while redesigning key discovery and institutional workflows:

| Area | Upstream [poco-ai/Agentero](https://github.com/poco-ai/Agentero) | **Dovero** ([nonsense-j/Dovero](https://github.com/nonsense-j/Dovero)) |
|---|---|---|
| **Product Focus** | Broad all-in-one platform (reading, LaTeX writing/compiling, mobile apps, hosted cloud services, plugins, etc.) | Streamlined **desktop-only workbench** focused on paper discovery, scholarly reading, literature survey, and local Agent collaboration |
| **Plaza & Paper Discovery** | External browsing feeds (Cool Papers, ModelScope, Papers with Code, RSS, arXiv recs) | Redesigned around a local `collection.sqlite` paper pool into five native panels: **Paper Collection** (28 official main-track venues + arXiv pool, pre-baked Seed sync, LLM keyword enrichment), **Paper Discover** (fast FTS5 search, in-pool citation lineage graph, Deep Search), **Paper Survey** (cited Related Work & HTML report generation), **Paper Recommend**, and **CCF Deadline** |
| **Institutional Access** | Generic Institution Proxy Gateway auto-detection | Built-in university **CARSI SSO** login and WebView session probing for publisher access detection (IEEE, ACM, etc.) and authenticated PDF ingestion |
| **Subsystem & Dependency Pruning** | Includes TeX/Writing compilation, iOS/Android mobile & Bridge, Remote Vault / SSH tunnels, Account & Cloud Credits, Word/Zhihu/Telemetry integrations, PDF Reflow, local layout model assets, and Tesseract OCR | Removes all non-core heavy subsystems listed on the left plus `@excalidraw/excalidraw` whiteboard support — zero accounts, zero telemetry, smaller bundle and maintenance surface |
| **UI & Interaction Philosophy** | Rapidly evolving into Zen multi-session workspace, offline dictionary overhaul, click-to-select layout elements, fullscreen immersive mode, and rail-peek comment trays | Emphasizes restraint, typography, and reading stability: unified styling for PDF margin notes, selection cards, Markdown note typography, Streamdown and Deep Search reports; retains visual-region framing and fixed gutter layout while selectively adopting focused upstream wins (400% zoom, copy rendered formula as LaTeX, expanded local citation previews, optional outside-click dismissal for translation cards) |
| **Translation & LLM Setup** | Drops Google Translate / DeepLX in favor of hosted/commercial flows | Keeps zero-key Google Translate / DeepLX options alongside enhanced **OpenAI-compatible** support (configurable 1–8 full-text concurrency, simplified 3-field OpenAI-compatible keyword LLM settings with model picker) |
| **Side-by-Side Isolation** | Bundle ID `com.poco-ai.agentero`, app config/data under `agentero/` | Independent bundle ID `io.github.nonsense-j.dovero`, `dovero://` deep-link scheme, and `dovero/` config & paper-pool directories (with automatic non-destructive migration from legacy `agentero/` on first launch), while keeping Vault `.agentero/catalog.sqlite` compatible with upstream |
| **Build & Release Flow** | Full cross-platform desktop + standalone CLI + iOS TestFlight + Homebrew Tap | Split per-platform GitHub Actions desktop builds (Windows x64 NSIS, macOS Apple Silicon & Intel) supporting unsigned fork builds out of the box |

---

## Core Features

### 1. Redesigned Plaza: Paper Collection, Discovery & Survey
- **Paper Collection**: Local `collection.sqlite` pool covering 28 official main-track venues and arXiv feeds, with one-click GitHub Release Seed sync, cancellable background refreshes, synonym-canonicalized search, and OpenAlex / Semantic Scholar / LLM keyword enrichment.
- **Paper Discover**: Instant local FTS5 Fast Search, interactive in-pool **Citation Lineage Graph** view, and multi-step **Deep Search** research synthesis.
- **Paper Survey**: Combines your local Vault, paper pool, and the `plaza_survey` MCP workflow (with TeX Introduction extraction) to produce cited Related Work drafts and exportable HTML survey reports.
- **Paper Recommend & CCF Deadline**: Local-library-based paper recommendations and upcoming CCF conference deadline tracking.

### 2. Structured PDF Reading, Annotations & Bi-Directional Notes
- **PDF Reading & Annotation**: True-scale EmbedPDF rendering up to **400% zoom**, outline navigation, full-text search, smooth text selection, multi-color highlights, margin comment cards, and **visual region framing** (annotate figures, tables, algorithms, and equations or ask your Agent directly).
- **Layout Analysis & Citation Previews**: Connects to remote or self-hosted layout providers (Paddle, MinerU 4.1, OpenAI-compatible) for structured figure/table/formula indexing; parses grouped text citations and local references with expandable local-paper preview cards, plus one-click arXiv and DOI links in the sidebar.
- **Multi-Mode Translation**: Selection translation (with optional outside-click dismissal), single-page/dual-pane and full-document layout translation across free zero-key engines, DeepL, Azure, Google Cloud, OpenAI-compatible endpoints (configurable 1–8 concurrency), and Agent translation.
- **Bi-Directional Markdown Notes**: Built-in Plate WYSIWYG editor paired side-by-side with PDFs (`⌘\` / `Ctrl+\` toggles the split and remembers width), supporting `[[wikilinks]]`, Obsidian Callouts, interactive pan/zoom Mermaid diagrams, `==highlight==` (including CJK-adjacent input) and `<u>underline</u>`, single-line `$$`/`\[`/`\(` and `\tag` block math normalization, and **one-click / context-menu LaTeX source copy** on rendered formulas.

<p align="center">
  <img src="docs/assets/agent.png" alt="PDF reading with agent assistance" width="90%" />
  <br/>
  <sub>Split-view reading and analysis: PDF highlights and annotations on the left, local Agent reasoning over structured context on the right</sub>
</p>

<p align="center">
  <img src="docs/assets/translate.png" alt="Selection translation linked to notes" width="90%" />
  <br/>
  <sub>Selection translation and note capture: key insights flow straight into local Markdown notes</sub>
</p>

### 3. Open Agent Protocol (ACP) & Local MCP Server
- **BYOA Local Agents (ACP)**: Built on the Agent Client Protocol to connect local agents such as Claude Code, Codex, OpenCode, and Antigravity CLI (`agy` with official installer lifecycle), supporting inline selection chips, in-page Quick Chat, structured ask-user cards, queued turns, and granular permissions — all with local context.
- **Built-in MCP Server**: Optional loopback Streamable HTTP MCP server (`127.0.0.1:8765/mcp`) letting external AI clients query your Vault, read notes, and import papers.
- **Headless CLI (`agentero-cli`)**: Command-line interface for headless Vault/Catalog operations, paper tag management, BibTeX import/export, and collection seed baking/importing.

### 4. Institutional Access, Zotero Compatibility & Transparent Local Storage
- **CARSI SSO & Flexible Ingestion**: Import papers via DOI / arXiv / title magic wand, PDF drag-and-drop, university CARSI SSO session support, or the local `127.0.0.1:23119` Zotero Connector browser extension.
- **Zotero Migration & BibTeX**: Import existing local Zotero libraries and export BibTeX / BibLaTeX.
- **Plain-File Local Storage & Self-Hosted Sync**: PDFs, Markdown notes, marks (`marks/`), and layout sidecars (`source/`) live as standard files in your Vault alongside `.agentero/catalog.sqlite` (kept compatible with upstream Vaults), readable by any external tool. Sync across devices using your own **S3-compatible storage, WebDAV, or Git** with nested paper-scope controls.

---

## Quick Start

### 1. Download Desktop Installers (Windows / macOS)

Download prebuilt installers from **[GitHub Releases](https://github.com/nonsense-j/Dovero/releases)**:
- **Windows (x64)**: `*-setup.exe` (NSIS installer)
- **macOS (Apple Silicon)**: `*_aarch64.dmg`
- **macOS (Intel)**: `*_x64.dmg`

> **Upgrading from earlier fork builds**: On first launch, Dovero automatically copies existing settings and `collection.sqlite` from legacy `agentero/` app directories into `dovero/` without modifying your Vault folders.

### 2. Run & Build from Source

Prerequisites: Node.js 24+, pnpm, and the Rust stable toolchain (MSVC Build Tools on Windows).

```bash
# Install frontend dependencies
pnpm install

# Launch desktop app in dev mode (Frontend + Rust Host)
pnpm tauri dev

# Build desktop installer bundle
pnpm tauri build

# Optional: build headless CLI
cargo build -p agentero-cli --release
```

For architecture and developer documentation, see [docs/architecture.md](docs/architecture.md), [docs/frontend/](docs/frontend/index.md), and [docs/backend/](docs/backend/index.md).

---

## Acknowledgements

- **Upstream [poco-ai/Agentero](https://github.com/poco-ai/Agentero)**: Deepest thanks to the original Agentero team and all upstream contributors for designing and open-sourcing the local-first research workbench architecture and open protocol stack. Dovero builds upon their work with streamlined scope and local redesigns while honoring upstream licensing and attribution.
- Thanks to the open-source projects and scholarly data services powering this workbench, including Tauri, React, EmbedPDF, Plate, Dockview, shadcn/ui, Streamdown, OpenAlex, Semantic Scholar, and CCF Deadlines.

## License

Licensed under the [MIT License](LICENSE). Third-party components and licenses are listed in [.github/THIRD_PARTY_NOTICES.md](.github/THIRD_PARTY_NOTICES.md).
