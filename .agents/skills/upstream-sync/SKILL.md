---
name: upstream-sync
description: >-
  Fetch poco-ai/Agentero upstream commits, run divergence-aware path triage from
  the recorded sync watermark, and selectively cherry-pick or surgically adapt
  safe improvements into this pruned fork without resurrecting deleted
  subsystems or colliding with local redesigns.
---

# Upstream Sync

将上游 `poco-ai/Agentero` 的增量改进安全、可控地选择性同步到本分叉仓库（`nonsense-j/Agentero`），在不复活已裁剪子系统、不破坏本地重设计功能（Plaza、CARSI、Windows 构建流）的前提下持续吸收修复与特性。

---

## 核心原则：为何禁止 `git pull` / `git merge`

本仓库并非上游的简单跟随分支，而是做过深度裁剪与局部重设计的本地优先分叉：

1. **大面积子系统已裁剪**：如 `writing` / `compile` / `rtex`、`mobile` / `bridge`、`remote` / `delegate` / `mcp/tunnel`、`account` / 云同步、`plugins`、`word` / `zhihu` / `telemetry`、`pdf/reflow` / `local` 布局模型资产 / `tesseract` 等（详见 [`references/divergence-map.md`](references/divergence-map.md)）。
2. **核心模块已重设计**：如 `plaza`（`collection.sqlite`、Paper Survey、Deep Search）、CARSI 机构单点登录、Windows 优先发布与构建流程。
3. **直接执行 `git pull` 或 `git merge`** 会把海量已删除文件重新拉回、制造跨数百文件的虚假合并冲突，并在 `bindings.ts` 与路由组件中复活死接口。

因此，本仓库统一采用 **Watermark-Bounded Selective Cherry-Pick（水位线有界选择性移植）**：以 `references/divergence-map.md` 中的 `Last Synced Upstream Commit` 为下界，`upstream/main` 为上界，先按路径自动化分流，再逐提交审查 diff 与依赖链，最后在隔离 worktree 中移植并验证。

---

## 执行流程

### 第一步：Pre-flight 安全检查与 Worktree 隔离

1. **先拍工作区快照，绝不破坏现场**：
   ```powershell
   git status --porcelain
   ```
   若主工作区存在未提交的 WIP（例如正在开发的 Plaza 或后台任务改动），**禁止**使用 `git reset --hard`、`git checkout --` 或直接切换分支。

2. **使用独立 `git worktree` 隔离移植**：
   当主工作区有脏文件，或需要并行验证多组切片时，创建基于当前目标分支（如 `main`）的 worktree，并将待移植提交按“零文件重叠”拆片。

3. **Windows worktree 依赖链接与清理铁律**：
   - 前端依赖使用目录 junction 共享主仓库 `node_modules`：
     ```powershell
     cmd /c mklink /J node_modules "<main-repo>\node_modules"
     ```
   - **严禁**在 PowerShell 中对 junction 执行 `Remove-Item -Recurse`（会顺着 junction 删除主仓库的 `node_modules`！）。卸载 junction 必须使用：
     ```powershell
     cmd /c rmdir node_modules
     ```
     并通过 `Test-Path node_modules` 确认为 `False`。
   - **不要**在 junction 上直接运行 `pnpm <script>`：pnpm 会因无 TTY 尝试移除 junction 并报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。worktree 中必须直接调用 `.\node_modules\.bin\<tool>`（如 `tsc.cmd`、`depcruise.cmd`、`vitest.cmd`、`biome.cmd`）。
   - **Rust / Tauri 共享构建缓存**：在 `dde17a92`（构建脚本运行时解析 `CARGO_MANIFEST_DIR`）落地后，worktree 可设置 `$env:CARGO_TARGET_DIR = "<main-repo>\target"` 复用编译产物。若需在 worktree 中运行 `agentero`（`src-tauri`）Cargo 测试，`tauri_build::build()` 仍要求 `src-tauri/pdfium` 与 `src-tauri/adapters` 存在，可临时对其建立 junction，测试完成后立即用 `cmd /c rmdir` 清理。

---

### 第二步：配置 Remote 与拉取上游更新

1. **统一走 SSH 拉取，禁用误推**：
   Windows 下 HTTPS 拉取大仓库易出现 `curl 28` 连接重置，优先使用 SSH：
   ```powershell
   git remote add upstream git@github.com:poco-ai/Agentero.git
   # 若已存在则校正 URL：
   git remote set-url upstream git@github.com:poco-ai/Agentero.git
   git config remote.upstream.pushurl DISABLE
   ```
2. **仅拉取 `main` 且不拉 tag**：
   ```powershell
   git fetch upstream main --no-tags
   ```

---

### 第三步：基于路径的自动化分流（严禁只看提交标题）

1. **运行分流脚本**：
   ```powershell
   node .agents/skills/upstream-sync/scripts/triage-upstream.mjs
   ```
   - 省略参数时，脚本自动从 [`references/divergence-map.md`](references/divergence-map.md) 读取 `Last Synced Upstream Commit` 作为 `<base>`，默认 `<target>` 为 `upstream/main`。
   - 也可显式传入区间与输出格式：
     ```powershell
     node .agents/skills/upstream-sync/scripts/triage-upstream.mjs <base> <target> --json
     ```
   - 脚本会拉取 `--no-merges --reverse` 提交列表、`git diff-tree --no-commit-id --name-status -r` 改动路径，以及 `git status --porcelain` 脏文件列表，给出**脏文件重叠预警**和五桶预分类。

2. **铁律：绝不凭 commit title 判断取舍**
   - 典型反例 1：`51747324` 标题是 `fix: sanitize AppImage loader env for child processes`，看似通用进程环境修复，实则修改了本地已删除的 `src-tauri/src/integration/mcp/tunnel.rs` 与 `mkdocs.yml`，属于非 Windows 场景且触及裁剪面，应跳过。
   - 典型反例 2：`0dde4cd2` 标题是 `feat(pdf): search the visible translation in find bar`，看似纯 PDF 查找修复，实则强耦合本地已裁剪的 `pdf/reflow`（`reflowDisplayDocument`），不可直接移植。

---

### 第四步：五桶分类模型（5-Bucket Classification）

| 桶位 | 含义 | 处理方式 |
|---|---|---|
| `ADOPT` | 命中共享模块，无结构漂移，不依赖未移植大系列 | 可直接 `git cherry-pick`（或仅解轻微行号偏移） |
| `ADAPT` | 有价值但命中契约热点、已裁剪分支、patch hash 或本地并行实现 | 必须按第五步规则做外科手术式改写与重新生成 |
| `SKIP_PRUNED` | 核心实现位于已裁剪子系统，或强耦合已删除符号（如 `mcp/tunnel.rs`、`pdf/reflow`） | 直接跳过，不移植、不复活死文件 |
| `SKIP_DIVERGED_OR_DUPLICATE` | 与本地重设计或已先行提交重复（如机构代理 vs CARSI、Vite `target/` 忽略、版本 bump、分叉文档） | 跳过，保留本地实现 |
| `DEFER_LARGE_SERIES` | 跨越大量文件/多轮提交的专题重构系列（如 `navigator`/vim、自动翻译队列、`rail-peek`、批注 Markdown 化等） | 本轮暂缓，记录 SHA 范围到 `divergence-map.md` 供后续专题评审 |

---

### 第五步：契约热点（Contract Hotspots）外科适配规则

移植 `ADAPT`（以及检查看似 `ADOPT` 的提交）时，必须逐条核对以下热点规程：

1. **IPC 契约与 `bindings.ts`（`src/lib/core/bindings.ts`、`src-tauri/src/app/{handlers.rs,bindings_test.rs,events_contract.rs}`）**
   - **严禁直接采纳上游的 `bindings.ts` diff hunk**。上游包含本地已裁剪的 command / event 类型，直接应用必然漂移。
   - 先在 Rust 侧完成适配并剔除裁剪分支（例如 `0281dec5` 适配 `src-tauri/src/integration/connector/state.rs` 时省略已删除的 `remote_registry` 与 `"remote session not found"` 校验）。
   - 然后重新生成 `bindings.ts` 并做双项只读校验：
     ```powershell
     $env:AGENTERO_UPDATE_BINDINGS="1"
     cargo test -p agentero export_typescript_bindings
     Remove-Item Env:AGENTERO_UPDATE_BINDINGS
     cargo test -p agentero export_typescript_bindings
     cargo test -p agentero app::events_contract
     ```

2. **共享壳层与路由文件（`doc-view.tsx`、`settings-content.tsx`、`palette-commands.ts` 等）**
   - 逐 hunk 剥离 `writing`、`texCompiling`、`mobile`、`remote`、`account`、`word-settings` 等裁剪分支。
   - 实例：`990ca524` 仅保留 `doc-view.tsx` 中的 `!tab.loaded` 与 `tab.mode === "markdown"` 早返回 `null`，跳过 `tab.texCompiling` hunk；`0281dec5` 的 `test/connector-settings.test.ts` 跳过对已删除 `@/components/settings/word-settings` 的 mock。

3. **本地并行实现检查（先查 `git log origin/main..HEAD`）**
   - 看到等价主题先检索本地提交历史，避免重复造轮子或覆盖本地更好方案：
     - **机构认证**：上游 `12753efc`..`a8a62aad`（Institution Proxy Gateway）已被本地 CARSI SSO（`87263709`、`b2249a15`、`7c196e97`）替代 -> `SKIP_DIVERGED_OR_DUPLICATE`。
     - **Vite 监听忽略 `target/`**：上游 `ba3e9b54` 重复本地已提交的 `7859891b` -> `SKIP_DIVERGED_OR_DUPLICATE`。
     - **无密钥自托管 Layout Provider**：本地 `LAYOUT_BACKENDS` 与 `provider-config.ts` 已提前移除 `"local"` 后端并回退至 `DEFAULT_LAYOUT_SETTINGS.backend`（`"paddle"`），移植 `430df797` 时不得恢复 `"local"`，且须把 `en/onboarding.json` 与 `zh-CN/onboarding.json` 的 `selfHostedHint` 适配为本地 `"Skip for now"` / `「暂时跳过」`。

4. **前置依赖与隐含耦合链检查**
   - 移植单点修复（leaf fix）前，必须通读其 diff hunk，确认调用的函数参数、DOM 属性或布局假设是否来自暂缓系列：
     - **不可孤立移植**：`207f2b00` 向 `selectionInsertionExclusions` 传入第 4 个参数 `"cached"`，该签名来自暂缓的跨页选择系列（`43a592de` + `4223792f`），必须一起暂缓/跳过。
     - **隐藏布局耦合**：`3ddf509e`（`centerReadingSurface`）与文档 hunk 耦合于暂缓的 `rail-peek` 系列（`fb9e3310..c15d4737` 移除 `rightGutter` 后引发的偏移），本地仍保留 `rightGutter`，应跳过并归入 `rail-peek` 评估。
     - **最小抽离独立适配**：`410a1c83` 在 `use-pdf-text-selection.ts` 中复用 `43a592de` 引入的 `event` 参数及 `[data-pdf-chrome]` / `[data-embed-pdf-page]` 守卫；可仅抽离该极小守卫，使焦点修复独立落地而不引入整个跨页选择系列。
     - **显式拓扑排序**：`a4b7df78`（Mermaid 交互视口）在 `src/lib/pdf/wheel-zoom.ts` 落地 `zoomOnWheel`，下游缩放修复（`47660560`、`98c02e43`）依赖此提交，必须先落前置再落后续。

5. **补丁 Lockfile 与双语 i18n**
   - 涉及 `patches/` 改动（如 `d582f586`、`8cc3f8f7`）时，勿直接应用上游 `pnpm-lock.yaml` hunk，应在主仓库运行 `pnpm install` 刷新 patch hash。
   - 所有新增或改写的 UI 文案必须同步更新 `src/i18n/locales/en/*.json` 与 `zh-CN/*.json`。

---

### 第六步：验证矩阵与水位线更新

1. **按改动范围执行最小充分验证**：
   - 前端类型检查：`pnpm typecheck`（worktree：`.\node_modules\.bin\tsc.cmd --noEmit`）
   - 循环/边界依赖检查：`pnpm deps:check`（worktree：`.\node_modules\.bin\depcruise.cmd --config .dependency-cruiser.cjs src`）
   - 代码格式与 Lint：定向 `biome check <touched-files>`（worktree：`.\node_modules\.bin\biome.cmd check ...`）
   - 单元测试：定向 `vitest run <related-tests>`（worktree：`.\node_modules\.bin\vitest.cmd run ...`）
   - Rust 基础层：`cargo test -p agentero-core`
   - IPC 契约（涉及 `src-tauri` command/event/bindings 时必跑）：`cargo test -p agentero export_typescript_bindings` 与 `cargo test -p agentero app::events_contract`

2. **Commit 规范与可追溯 Trailer**：
   - 每个移植提交使用 Conventional Commits 标题，**禁止使用 emoji**。
   - 在 commit body 末尾追加上游源提交 trailer：
     ```text
     Upstream-Commit: <40-char-upstream-sha>
     ```

3. **推进水位线与同步日志**：
   - 整轮同步合并完成后，更新 [`references/divergence-map.md`](references/divergence-map.md) 中的：
     - `Last Synced Upstream Commit: <new-40-sha>`
     - Empirical Sync Log（已落地提交、跳过原因、暂缓系列 SHA 范围及剩余独立候选）
   - 再次运行 `node .agents/skills/upstream-sync/scripts/triage-upstream.mjs`，确认待处理提交数为 `0`。
