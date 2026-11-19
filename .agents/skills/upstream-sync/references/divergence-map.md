# Upstream Divergence Map (`poco-ai/Agentero` vs `nonsense-j/Agentero`)

本文件记录本分叉仓库（`nonsense-j/Agentero`）相对上游（`poco-ai/Agentero`）的子系统裁剪边界、重设计分叉区、契约热点与历史同步水位线，作为 `triage-upstream.mjs` 与人工选择性移植的权威依据。

## Current Sync Watermark

Last Synced Upstream Commit: 3585e46edb97561b23e886395e0ab81ba36a83e8

- **Upstream Remote**: `git@github.com:poco-ai/Agentero.git` (`pushurl=DISABLE`)
- **Upstream Target Branch**: `upstream/main`
- **Last Synced Range**: `affa128e3c7a3cdb9d4c0b6b9cf855a79f1861bf..3585e46edb97561b23e886395e0ab81ba36a83e8`（221 non-merge commits，于 2026-11-19 完成逐提交审计与 62 个本地移植提交，覆盖 65 个上游提交）
- **Common Ancestor (`git merge-base HEAD upstream/main`)**: `b551f588c076f68effff5a32b4fd5f1035be7f04`

---

## 1. Pruned Subsystems（已裁剪子系统 — 严禁复活）

本地通过三次核心裁剪提交移除了非科研阅读/本地优先主线的重型模块与死代码：

- `a1103589d` (`refactor: prune obsolete subsystems, heavy native crates, and dead ipc surface`)
- `25de99ae3` (`refactor(frontend): remove dead files, forwarding shims, and unguarded account mount`)
- `086f0eea4` (`refactor: remove remaining writing, remote delegate, and hosted cloud sync leftovers`)
- 配套文档/配置裁剪：`2d4e8cf98`、`e869fce0f`、`68f6f2e26`、`7ed7361ad`

| 裁剪子系统 | 本地已删除/移除的关键路径与符号 | 对应裁剪提交 | 处置原则 |
|---|---|---|---|
| **Writing / TeX / Compile / rtex** | `src-tauri/src/features/writing/`、`src-tauri/src/features/compile/`、`src-tauri/src/features/rtex/`、`src-tauri/rtex/`、`src/components/writing/`、`src/lib/writing/`、`src/lib/tex/`、`src/lib/tex-live/`、`src/components/viewer/texlive/`、`src/components/viewer/tex-citation-picker.tsx`、`src/components/viewer/text-editor-lint-footer.tsx`、`src/components/viewer/pdf/hooks/use-pdf-synctex.ts`、`src/hooks/use-tex-root.ts`、`src/components/sidebar/use-tex-project.ts`、`src/components/sidebar/file-tree/hooks/use-tex-compile.ts`、`src/lib/workspace/{tex-compile,tex-outline-bridge,writing-focus,actions-latex-translation}.ts`、`templates/vault/thesis/`、`templates/vault/.agents/skills/research-paper-writing/`、`latex{Build,Language,Pdf}.json`、Tab `texCompiling` 分支 | `a1103589`, `25de99ae`, `086f0eea` | `SKIP_PRUNED`；若命中共享文件（如 `doc-view.tsx`），剥离 `texCompiling` 等 hunk |
| **Mobile / Bridge / iOS / Android** | `src/components/mobile/`、`src/lib/bridge/`、`src-tauri/src/integration/bridge/`、`src-tauri/gen/android/`、`src-tauri/gen/apple/`、`src-tauri/ios-project.yml`、`src-tauri/tauri.{android,ios}.conf.json`、`scripts/ios-*`、`.github/workflows/ios-testflight.yml`、`mobile.json` | `a1103589`, `7ed7361ad` | `SKIP_PRUNED` |
| **Remote Vault / Delegate / MCP Tunnel** | `src-tauri/src/integration/remote/`、`src-tauri/src/features/agent/delegate/`、`src-tauri/src/integration/delegate_mcp.rs`、`src-tauri/src/integration/mcp/tunnel.rs`、`src/lib/mcp/tunnel.ts`、`src-tauri/src/features/agent/{remote_host.rs,commands/remote.rs,registry/remote.rs}`、`src/lib/vault/{remote/,remote-path.ts}`、`src/components/dialogs/remote-vault-dialog.tsx`、`src/components/settings/panes/remote-access-pane.tsx`、`remote_registry` | `a1103589`, `086f0eea` | `SKIP_PRUNED`；在 `connector/state.rs` 等共享代码中剔除 `remote_registry` 与 `"remote session"` 检查 |
| **Account / Hosted Cloud Sync** | `src-tauri/src/app/account.rs`、`src/features/account/`、`src/components/settings/panes/account-pane.tsx`、`src/components/settings/cloud-usage.tsx`、`src/components/settings/panes/about-feedback.tsx`、`crates/agentero-core/src/features/sync/agentero.rs`、`crates/agentero-core/src/remote.rs`、`account.json`（注意：本地仍保留 `sync/config.rs`、`git.rs`、`s3.rs`、`webdav.rs` 等本地同步实现） | `a1103589`, `25de99ae`, `086f0eea` | `SKIP_PRUNED` |
| **Plugin Host / Broker** | `crates/agentero-plugin-host/`、`crates/agentero-core/src/plugins.rs`、`src-tauri/src/integration/plugins/`、`src/components/settings/panes/plugins-pane.tsx`、`src/lib/plugins/`（上游亦已于 `5a2d3d4b3` 移除） | `a1103589`, `25de99ae` | `SKIP_PRUNED` |
| **Word / Zhihu / Telemetry** | `src-tauri/src/integration/word/`、`src/components/settings/word-settings.tsx`、`src/components/dialogs/word-citation-dialog.tsx`、`src/lib/word/`、`crates/agentero-core/src/features/zhihu/`、`src-tauri/src/features/zhihu/`、`src/components/agent/zhihu-discussions.tsx`、`src/components/settings/panes/agent/zhihu-agent-row.tsx`、`src/lib/zhihu.ts`、`src-tauri/src/core/telemetry/`、`docs/backend/word.md`、`docs/frontend/zhihu.md` | `a1103589`, `25de99ae` | `SKIP_PRUNED`；单测中剔除 `@/components/settings/word-settings` 等 mock |
| **PDF Reflow / Local Layout Assets / Tesseract / Excalidraw** | `src/lib/pdf/reflow/`、`src/components/viewer/pdf/hooks/{use-pdf-reflow,use-reflow-display-document}.ts`、`src/components/viewer/pdf/layers/reflow-page-overlay.tsx`、`reflowDisplayDocument`、`src-tauri/src/features/paper/analyze/layout/model_assets/`、`src/hooks/use-layout-model-prefetch.ts`、`LAYOUT_BACKENDS` 中的 `"local"`、`vendor/tesseract-rs`、`src/components/viewer/excalidraw-viewer.tsx`、`templates/vault/.agents/skills/acdemic-drawing/` | `a1103589`, `e869fce0f`, `e0a61c29c` | `SKIP_PRUNED`；`layout` 相关改动禁止重新引入 `"local"` 后端（注意：`mkdocs.yml` 在本地仍存在，不作为裁剪判定依据） |

---

## 2. Redesigned / Diverged Subsystems（本地重设计与分叉区）

以下领域本仓库已独立演进或有等价本地实现，同步前必须先对比 `git log origin/main..HEAD`：

| 领域 | 本地实现 | 上游对应实现 | 处置策略 |
|---|---|---|---|
| **Plaza（论文广场 / Collection / Survey / Deep Search）** | 基于 `collection.sqlite`、CCF/venue 通道、Paper Survey、`plaza_survey` MCP 与 Deep Search 独立重写（保留并持续演进 `docs/development/plaza.md`） | 上游沿用旧版 Plaza / 曾删除 `docs/development/plaza.md`（`3c116e17`）并另走 `rfc-scholarly-data-resolution.md`（`10485386`） | `plaza-feeds-*` 等独立 UI 小修可按需 `ADOPT`/`ADAPT`；架构文档、`collection`/`recommend`/`ccf` 改动需按 `SKIP_DIVERGED_OR_DUPLICATE` 或谨慎 `ADAPT` 处理，严禁覆盖本地 `docs/development/plaza.md` |
| **机构学术访问认证** | CARSI Publisher SSO + WebView session 探测 + IEEE/ACM 访问检测（`872637091`, `b2249a150`, `7c196e976`） | Institution Proxy Gateway 自动探测与适配器注册表（`12753efce`..`a8a62aad3`） | `SKIP_DIVERGED_OR_DUPLICATE` |
| **Windows 构建 / CI / Release 流程** | Windows 优先发布拆分（`3f0b407ed`）、Vite 忽略 Rust `target/` 监听（`7859891b1`）、本地 `.agents/skills/{bump,commit,release}/` | AppImage 专项修复（`51747324`）、上游 `0.15.5`/`0.16.0` 版本 bump（`cce3e75c`, `75e366c9`）、上游 release skill 文档（`c5996ca6`） | `SKIP_DIVERGED_OR_DUPLICATE`（`dde17a92` 跨平台 build-script 运行时 manifest 修复除外，已 `ADAPT` 落地） |

---

## 3. Shared Subsystems & Contract Hotspots（共享契约热点）

修改以下路径时，即使 commit 主题安全，也必须归类为 `ADAPT` 并做外科手术式验证：

| 热点文件/目录 | 风险原因 | 强制规程 |
|---|---|---|
| `src/lib/core/bindings.ts`、`src-tauri/src/app/{handlers.rs,bindings_test.rs,events_contract.rs}` | 本地已删减大量 command/event，直接采纳上游 `bindings.ts` hunk 会导致类型漂移或引入死接口 | **严禁**直接应用上游 `bindings.ts` diff；先适配 Rust，再用 `$env:AGENTERO_UPDATE_BINDINGS="1"; cargo test -p agentero export_typescript_bindings` 生成，再跑只读校验与 `app::events_contract` |
| `src/components/workspace/doc-view.tsx`、`src/components/settings/settings-content.tsx`、`src/components/shell/palette-commands.ts` | 路由与视图容器曾包含 `writing` / `texCompiling` / `account` / `plugins` / `remote` / `word-settings` 分支 | 逐 hunk 检查，剔除已裁剪 tab/pane 引用，保留有效逻辑 |
| `src-tauri/src/integration/connector/state.rs` | 本地移除 `remote_registry` 与 `remote:` vault 支持 | 移植连接器状态机或端口重试时省略 `remote_registry` 分支并重跑 `connector::state::tests` |
| `src/lib/pdf/layout/{provider-config.ts,providers.ts}` | 本地已移除 `"local"` 布局后端，回退到 `DEFAULT_LAYOUT_SETTINGS.backend`（`"paddle"`） | 不恢复 `"local"`，将引导提示适配为本地文案（如 `"Skip for now"` / `「暂时跳过」`） |
| `src/components/viewer/pdf/pdf-viewer.tsx`、`src/lib/pdf/wheel-zoom.ts`、`src/components/viewer/pdf/hooks/use-pdf-text-selection.ts` | 承载了未移植的大系列（`rail-peek`、跨页选择、`navigator`/vim）与独立缩放修复的交叉上下文 | 先排查 hunk 是否依赖未移植函数的参数或 DOM/CSS 契约（如 `selectionInsertionExclusions`、`rightGutter`） |
| `patches/@embedpdf__*.patch`、`pnpm-lock.yaml`、`Cargo.lock` | 锁文件与补丁 hash 强依赖当前依赖树 | 不直接套用上游 `pnpm-lock.yaml` hunk，应在主仓库运行 `pnpm install` 刷新 patch hash |
| `src/i18n/locales/en/*.json` ↔ `src/i18n/locales/zh-CN/*.json` | 任何文案改动必须双语成对同步 | 检查 `en` 与 `zh-CN` 键集合一致，适配不存在的按钮引用 |

---

## 4. Empirical Sync Log（`7bb9eb9c..affa128e`）

### 4.1 本轮已移植并验证通过的 13 个提交（3 个切片）

| 切片 | 上游 SHA (40-char) | 原始主题 | 处置方式与适配要点 |
|---|---|---|---|
| **Slice 1** | `dde17a928a51684fdbfdc74bafbcc0f343e6bca6` | `fix(build): resolve manifest directories at build-script runtime` | `ADAPT`：`crates/agentero-core/build.rs` 零漂移；`src-tauri/build.rs` 适配 `forward_build_env` 附近行号偏移（保留 Windows comctl32 manifest 块），使跨 worktree 共享 `CARGO_TARGET_DIR` 成为可能 |
| **Slice 1** | `e8b4b5104105da33928b789d375665d273dd8833` | `fix(import): preserve uniqueness for long paper slugs` | `ADOPT`：仅改 `slug_from_stem` 及单测，与本地 `import/mod.rs` CARSI 改动互不重叠 |
| **Slice 1** | `33c5cfef1f81c3e08d24d2638b08f0aa0a09c553` | `fix(pdf): support self-hosted MinerU 4.1 via /v1/tasks` | `ADOPT`：`mineru.rs` 与文档零漂移 |
| **Slice 1** | `430df797e9794579fc12eeb337922803d60ea307` | `fix(layout): allow configuring a keyless self-hosted provider` | `ADAPT`：保留本地无 `"local"` 后端的 `LAYOUT_BACKENDS` 与 `DEFAULT_LAYOUT_SETTINGS.backend`（`"paddle"`），将 `onboarding.json` 的 `selfHostedHint` 适配为 `"Skip for now"` / `「暂时跳过」` |
| **Slice 1** | `404ad9948001296d1f10967995e432b7211c63ad` | `feat(wiki): complete paper titles with canonical PDFs` | `ADOPT`：零漂移 |
| **Slice 1** | `0281dec573d5cccf60bb15d869a5bbda5c3da3b0` | `fix(connector): recover from occupied ports and localize failures` | `ADAPT`：`connector/state.rs` 剔除 `remote_registry` 与 remote session 分支；`test/connector-settings.test.ts` 剔除已删 `word-settings` mock；用 `AGENTERO_UPDATE_BINDINGS=1` 重新生成 `bindings.ts`（仅新增 `ConnectorErrorCode` 与 `ConnectorStatus.lastErrorCode`）并验证 `app::events_contract` |
| **Slice 2** | `990ca52461f8894dcfde9492a1ad9bd545508d8c` | `perf(workspace): unmount loading skeletons for inactive background tabs` | `ADAPT`：在 `doc-view.tsx` 中跳过已裁剪的 `tab.texCompiling` hunk，保留 `!tab.loaded` 与 `markdown` 模式早返回 `null` |
| **Slice 2** | `a4b7df7816d7ea874a70418d6a93e11f8f36b6fd` | `feat(markdown): add interactive Mermaid viewport` | `ADOPT`：零代码漂移；在 `src/lib/pdf/wheel-zoom.ts` 落地 `zoomOnWheel`，为下游缩放修复（`47660560`, `98c02e43`）扫清前置依赖 |
| **Slice 3** | `8296820cd5aa79ad884723aa848113471fafdd63` | `fix(pdf): restore annotation dates when reopening highlights` | `ADOPT`：代码与测试零漂移；合并 `docs/frontend/pdf.md` 邻近表格行 |
| **Slice 3** | `179216650e88eebfb398b3b14a6826a9e78cc7cf` | `fix(pdf): use raw layout bbox for section focus` | `ADOPT`：独立落地（跳过 `docs/frontend/agent.md` 1 行跨切片 hunk） |
| **Slice 3** | `410a1c83f7481838dc20b8b7a2b7b72dd0a83e7c` | `fix(pdf): keep keyboard focus on the clicked viewer` | `ADAPT`：`dockview-viewport.tsx`（`tabIndex={paginated ? 0 : -1}`）干净应用；从暂缓提交 `43a592de` 中最小抽离 `releaseNativeSelectionForPdfPointer` 的 `event` 参数与 `[data-pdf-chrome]` / `[data-embed-pdf-page]` 守卫，实现无系列耦合的独立落地 |
| **Slice 3** | `58d931fe1138c64e844977b5624474ef7e8a399d` | `fix(pdf): keep the dragged translation card width` | `ADOPT`：独立于选区快捷翻译改动 |
| **Slice 3** | `41ba040d9917079a10c6f0c9909e4bbbaccd5c57` | `fix(pdf): drop stale translation highlights` | `ADOPT`：`highlights.ts` 与测试零漂移，`pdf-viewer.tsx` 仅轻微行号偏移 |

### 4.2 本轮明确跳过（强耦合 / 裁剪 / 分叉 / 重复）

- **因隐藏依赖链跳过的叶节点修复**：
  - `207f2b0082884be288df0815672fe29fe52d67aa` (`fix(pdf): avoid first-selection highlight delay`)：向 `selectionInsertionExclusions(...)` 传入第 4 个参数 `"cached"`，该参数接口由暂缓的跨页选择系列（`43a592de` + `4223792f`）引入，不可单独移植。
  - `3ddf509efc59bdb6b4d90e6cfe48e5d503ea3620` (`fix(pdf): center the page when fitting width`)：其 `centerReadingSurface` 与文档 hunk 耦合于暂缓的 `rail-peek` 系列（`fb9e3310..c15d4737`）对 `rightGutter` 的移除，本地仍保留 `rightGutter`，应随 `rail-peek` 一并评估。
- **因触及裁剪面跳过（`SKIP_PRUNED`, 10 commits）**：
  - TeX / Writing：`b61c9b87`、`257b72b7`、`c8ab1e90`、`b85f7aa5`、`78bb2e31`
  - **欺骗性标题反例**：`5174732487250695c16ac9c54dbddcd936f5d828`（标题为 `fix: sanitize AppImage loader env for child processes`，实则修改已删除的 `src-tauri/src/integration/mcp/tunnel.rs` 与 `mkdocs.yml`，且为 AppImage 场景）
  - Reflow 耦合：`0dde4cd2913a726fdda132ad820f47cb90273729`（`feat(pdf): search the visible translation in find bar`，强耦合已删除的 `reflowDisplayDocument`）
  - 其他裁剪文档/依赖：`3c116e17`（删 `docs/development/plaza.md`、改 `mcp/tunnel.rs` 等）、`34cad5ec`（修 `mkdocs.yml` 与 RFC）、`cddeb398`（`tesseract` patch）
- **因分叉或重复跳过（`SKIP_DIVERGED_OR_DUPLICATE`, 10 commits）**：
  - 机构代理系列（被本地 CARSI 替代）：`12753efc`、`bf794173`、`ef6aeddd`、`a8a62aad`
  - 本地已有等价修复：`ba3e9b54`（Vite 忽略 `target/`，重复本地 `7859891b`）、`a597f6b6`（`mkdocs.yml` nav 清理，本地已于 `e869fce0f` 裁剪）
  - 上游版本发布/分叉文档技能：`cce3e75c`（`0.15.5`）、`75e366c9`（`0.16.0`）、`10485386`（scholarly data RFC）、`c5996ca6`（上游 release skill）

### 4.3 本轮暂缓的大型系列（77 commits，供后续专题评估）

| 系列 | 提交数 | 上游 SHA 范围 / 代表提交 | 暂缓原因与前置说明 |
|---|---:|---|---|
| **Series A: Auto-Translate Queue, Partial Recovery & Layout Readiness** | 29 | `9a84f8af`..`07d05089`（含 `9a84f8af`, `b7db8550`, `77dafb9e`, `4927c948`, `955b6463`, `e5a8bbac`, `07d05089` 等） | 跨 Rust `jobs`/`translate`/`import`/`connector`、`bindings.ts`、已裁剪 `pdf/reflow` 与前端翻译状态机的大规模重构 |
| **Series B: Navigator / Global Hint Mode / Vim Keybindings** | 25 | `838d63e6`..`cd9b2aa3`（含 `42c3b954`, `aa1322e4`, `bc179a0e`, `cd9b2aa3` 等） | 侵入 App 根部、settings、文件树、dockview、PDF 阅读器与选区菜单的全局键盘接管层 |
| **Series C: Comment Rail Peek Refactor** | 7 | `fb9e3310`..`b44c8d53`（另附耦合修补 `3ddf509e`） | 移除 `rightGutter` 并引入视口平移式评论栏弹出，需成组评审 |
| **Series D: Library Multi-Select Marquee & Batch Copy** | 1 | `bdc90496` | 单提交 24 文件跨 `agentero-core`、Tauri IPC 与文库 UI |
| **Series E: Cross-Page Text Selection & Formula Exclusion** | 4 | `43a592de`、`4223792f`、`207f2b00`、`502622a5` | 30+ 文件重构 + `@embedpdf/plugin-selection@2.14.4` patch |
| **Series F: Comment Card Fixed Sizing & Plate Markdown Editor** | 6 | `2cf4275d`..`376b7b90` | 重写 `comment-cards-layer.tsx` 布局并引入 Plate Markdown 批注编辑器 |
| **Series G: Annotation Undo/Redo History** | 2 | `75dc801b`、`9c5a3bf4` | 新增全局批注操作历史栈（`9c5a3bf4` 含已裁剪的 `pdf-reflow-overlay.test.ts`） |
| **Series H: Underline Annotations & Per-Swatch Shape Toggle** | 3 | `a524428f`、`4f27138c`、`affa128e` | 36 文件改写批注形状与下划线渲染（含已裁剪的 `reflow-page-overlay.tsx`） |

### 4.4 `7bb9eb9c..affa128e` 区间内尚未移植的独立候选提交（供后续按需单挑）

以下提交经分流确认不属于上述 8 个大系列，在 2026-11-13 水位线推进至 `affa128e` 时未纳入首批 3 个切片，后续若需单独回补可直接按 SHA 独立提取（注意遵循对应前提与热点规程）：

- **PDF 缩放与补丁**（与 `rail-peek` 无关，需在主仓库刷新 `pnpm-lock.yaml` patch hash，且 `47660560`/`98c02e43` 依赖已落地的 `a4b7df78`）：`d582f586`、`289833e3`、`47660560`、`98c02e43`、`a1f7ab41`、`72efa44a`、`8cc3f8f7`
- **选区翻译卡片 / 词典 / Index-Translate / Bilibili 流式**（`4e724d1a` 依赖 `2023b03f` 与 `167dec5c` 并需更新 `bindings.ts`）：`167dec5c`、`7e79473e`、`ee86d15a`、`71af8635`、`2023b03f`、`4e724d1a`
- **Agent CLI 发现与 Ask-User 卡片**（`0ae1f165` 依赖 `046cd650`）：`046cd650`、`0ae1f165`、`154cddac`
- **Settings 同步事件 & 提示音效**（均涉及 `bindings.ts` / `events_contract.rs`）：`edc75545`、`a195230f`、`dff644d5`、`b25a2b37`
- **Plaza Feeds UI 微调 & CCF 类别过滤**（`d31463f0` 需待本地 `docs/development/plaza.md` WIP 处理后合并）：`19debee2`、`498d40fc`、`ccca1ead`、`c7303820`、`d31463f0`
- **Release updater 脚本小修**：`46c61557`、`addbb3a5`、`be8898d2`

---

## 5. Empirical Sync Log（`affa128e..3585e46e`，2026-11-19）

本轮以「功能实现和 UI 设计以当前实现为主，优先修复当前代码库真实存在的 Bug，仅吸收契合本地优先科研工作台理念的轻量高价值增量与减包清理」为准则，审查全部 221 个非合并提交。

### 5.1 已移植并验证通过的 Bug 修复（51 个本地提交，覆盖 52 个上游提交）

- **Windows 路径 / 壳层 / 窗口资源**：`1c6e9d00e`（Windows `\\?\` 根路径归一）、`2fb6c6eec`（`ADAPT`：本地 `vault/fs.ts` 与 `joinPath` 路径归一）、`790242734`（`ADAPT`：Windows 标题栏 Agent 窗口菜单改为 `DropdownMenu`）、`f9e7820ee`（`ADAPT`：左右栏折叠保留 `ResizableHandle`，#1163）、`dd0e498c9`（启动读取布局失败保留原配置）、`f7148b00c`（`ADAPT`：论文资源引用计数共享 blob URL）、`931cc2680`（`ADAPT`：弹出窗口 `vaultHold` 剔除已删 `isRemoteVaultHandle`）
- **Vault Sync 数据安全与排错**：`d85e71b31`（`ADAPT`：保留 `ApiError.code`、解释 Git 认证与 TLS 证书失败）、`21b446ee4`（`ADAPT`：嵌套论文目录作用域与远端数据保护，#1165/#1166，剔除已删云同步与未移植 HTTP/CA 字段）
- **PDFium / Wiki / MCP / Plaza / Connector / Clippy**：`2e0e2fe6a`、`56d2c01bd`（PDFium 路径预加载与托管 CLI 随附放置）、`fe7723030`（纯空白双链重命名防 panic）、`97ff6d9af`、`31949343a`（MCP 图标去重 #1139、按接口提供 invariants #1141）、`61b2ca74e`（Papers with Code 搜索拦截 HF 登录页 #1164）、`ca21fa45c`（Clippy `needless_bool`）、`4d6ac1116`、`ab4395e28`（Connector 重试测试稳定化）
- **Markdown / Editor / Agent / Tasks**：`5739f5c54`（Agent 表格导出保留 KaTeX LaTeX）、`25faf7f59`（`@platejs/markdown@53.2.2` 相邻 `<mark>`/`<u>` 序列化补丁 + `pnpm install`）、`6fb6e9aaf`、`2f5ae5a02`（`ADAPT`：剔除缺失 `sent-annotation-chip.tsx`）、`2e69d332b`（`ADAPT`：剔除缺失 `comment-markdown-kit.ts`）、`621ec7bb5`（`==highlight==` 解析、MDX 回退与 CJK 输入规则，#1168/#1170）、`1a84947dc`、`3585e46ed`（单行 `$$`/`\[`/`\(` 渲染与 `\tag` 提升块级公式，#1162）、`43f20879f`（`ADAPT`：无本地缓存的历史会话不再打开成空白对话）、`e6f072c42`（`ADAPT`：过滤 Codex 指令超限 Warning 并重新生成 `bindings.ts`，#1132）、`aa39a6aae`（已完成后台任务保留至清除）
- **工作区分屏与最大化**：`973984959`（`ADAPT`：剔除 TeX 分支）、`0e29fcaa6`、`fa42b51be`、`db635f1a4`、`73f36b5ed`（保留本地 `b903d1920` `PaperPathBar` 行为，明确跳过 `8185a9c82`）
- **PDF 选区 / 翻译掩码 / 图注合并 / 引用解析**：`05b8636f5`（`ADAPT`：原子掩码嵌套公式，跳过 reflow 测试 hunk，#1111）、`63c520236` + `7f5974268`（`ADAPT`：颜色面板向左展开与防悬停抖动，合并 1 提交）、`61356292f`、`e7c526c50`、`0b6612ffe`、`6f73edd12`、`540f956ed`、`4e9aa2a8f`（`ADAPT`：图注与完整图表合并链，剔除不存在的 `omnidocbench-bbox`）、`fc7ff4e08`、`aebaa9b24`、`94cc3959b`（`ADAPT`：`use-pdf-page-text.ts` 最小暴露 `pageTextRects`）、`a27ae61a1`、`534236cde`、`7970ae358`、`caf0e3a41`、`d5ced3b02`、`c14bd69e8`

### 5.2 已移植并验证通过的精选新特性与精简清理（11 个本地提交，覆盖 13 个上游提交）

- **PDF 400% 缩放上限**：`37452dfc6`（`ADOPT`）
- **本地引用详情展开预览**：`1ef8772cb`（`ADOPT`）
- **渲染公式复制 LaTeX 源码**：`fb2f26ab7`（`ADAPT`：保留本地 `b903d1920` 公式样式与 `2f5ae5a02` Streamdown 钩子）、`22300c96a`、`d210ca962`、`68fe323cf`、`b41059462`（`2399b5573` 已被 Biome 覆盖）
- **侧栏 Paper Info DOI 外链按钮**：`6a2540c3f`（`ADAPT`：适配本地无知乎提问按钮布局）
- **Antigravity CLI（`agy`）官方安装器生命周期**：`0afc5b959` + `76d978050`（合并 1 提交，重生成 `bindings.ts`）
- **OpenAI 兼容接口全文翻译并发数可配置（#1155）**：`0ea95cc78`（`ADAPT` + 重生成 `bindings.ts`）
- **划词翻译卡片点击外部自动关闭开关（#1140）**：`db19bfdf3` + `77c9f31b0`（`ADAPT`：保留本地 `52cafcce4` 卡片视觉样式 + 重生成 `bindings.ts`）
- **移除 Excalidraw 白板支持与 `@excalidraw/excalidraw` 依赖**：`992aa5c17`（`ADAPT`：剔除 `compileTexOnManualSave` 并运行 `pnpm install` 净移除 95 个依赖包）

### 5.3 本轮明确跳过或暂缓（按设计理念与依赖边界）

- **本地已有修复 / 冲突覆盖（跳过）**：`ba6ada444`（本地 `jev/service.rs` 已用 `BATCH_SIZE = 8`、`8 * 5 = 40 <= 64` 解决）、`8185a9c82`（与本地 `b903d1920` 的 `PaperPathBar` 条件冲突，保留本地）、`4bd955a76`（保留 Google Translate / DeepLX 零配置免费源，适配本地优先定位）、`8d50d7f34`/`76490f4be`/`8eca290cf`/`ff4c5bf12`/`aec586377`/`b22be2be0`（本 fork `release.yml` 不发布独立 CLI 资产，不应启动自动拉取 CLI）、`075da884b`/`440a8ade5`（本地仍使用 `plugin-zoom` 补丁的 `viewportPaddingRight`，严禁删除）。
- **已裁剪子系统 / 版本号 / 基准与测试重组（跳过）**：TeX/Writing（10 提交）、PDF Reflow 与自动翻译队列（20+ 提交）、Account/Cloud（`26d011094`, `c251be9b2`）、上游删除 Local Plugins（`5a2d3d4b3`，本地已裁剪）、AppImage（`19ef0a4bf`）、版本 bump（`31c5efd0d`, `cf52b37d0`）、Bbox Benchmark（`884c90d1e`, `df9621bd9`）、大规模测试重组（`6c780b359`, `5a3cb31eb`, `05eb02909`, `0355eca75`）。
- **依赖暂缓前置或偏离当前精简理念的新增系列（暂缓）**：
  - **Zen 多会话 Agent 工作区**：`65f6ae873`、`5b2a16685`、`958a0258a`、`c6d68b4a9`、`8fe020185`、`44ce1bb8a`、`6e3dae68d`
  - **离线词典与术语表（ECDICT + AI 词库）**：`df4bb8471`/`9c41c9350`、`102d1a41b`..`2a751ee93`、`f23581535`
  - **PDF 版面元素点击选中替代框选批注 + 句子悬停高亮**：`4cbee4c92`、`75f74d6cd`、`52e38d05b`、`83e2fb50d`、`291b97e60`、`c0a01496d`、`16ec3ee52`、`8e7aad38d`、`1a7ac7dd8`、`357cf8466`、`821d558cc`、`1b968c7f7`、`c159bd2d9`、`eb4aaaa4a`、`403919fa3`、`a80a143e4`
  - **全屏沉浸阅读模式**：`4062d9da2`、`f2d569206`、`9949d4b83`、`a2917b8a7`、`7acc83ed4`、`26eb742db`、`820f5a832`
  - **多窗口 View-ID 架构重构**：`5ee8e36f7`、`6120b4924`、`897dd8e3f`、`b7ccce8e2`、`60c067f95`、`6892ad356`、`f37a109ed`、`90a85aac5`、`21c02e610`
  - **其他按需可选候选**：Zotero PDF 高亮/下划线导入（`b00b88075`、`c29f81583`、`a178ab0b1`、`b944ce94b` — 需配合 Series H `UNDERLINE` 标注支持一并评估）、Agent 历史内联批注芯片（`5f003c791`、`cb1345301`）、本地阅读与 Agent 用量看板（`ed7fedacb`、`4c49db53d`、`84ff68f50`、`bb35a02ff`）、Headless CLI 远程版面解析（`7c0a24de4`）、ACP 历史连接池预热（`64beb4bee`）、Git Sync 纯 HTTP / PEM CA（`f077c8ee2`、`2eb04cdbe`、`4da33d0d1`、`0a8fd1e24`、`2800ebc73`、`7fdc1fe2b`）、`rmcp 3.10` 升级与 SEP-2549 缓存头（`70f77c740`、`852e23c3f`）、桌面端打包 CLI 发现（`b863165c1`，依赖 `046cd6502`+`0ae1f1654`）、jEV 并发/超时设置 UI（`ab10772c4`、`b0a337986`、`47c5fb838`、`6bca3e474`）、Linux 终端 Ghostty 与 Agent 终端偏好（`a7d94b727`、`9c84b574b`）、Onboarding 引导流程改动（`cb08cd6aa`、`571747640`、`74af37d8f`、`7ac027523`）、Windows ARM64 发布流（`4dea62c62`、`b9d4db727`）。
