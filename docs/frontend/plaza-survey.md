# 广场 · Paper Survey

虚拟路径 `agentero:plaza/survey`，注册于 `src/lib/plaza/sources.ts`（`panel: "survey"`，图标 `PlazaSurveyIcon`，中英文侧栏标签统一为 `Paper Survey`）。用户从论文库选出种子论文、给定具体主题、选择输出格式，由 ACP Agent 阅读种子论文核心内容并在本地论文集（`agentero-collection` MCP）中检索相关工作后撰写结果。

## 入口与布局

| 区域 | 组件 | 说明 |
|---|---|---|
| 顶栏 | `plaza-survey-view.tsx` | 标题（`Paper Survey`）、历史切换（Popover，支持两次点击删除）、新建综述、本地 `Paper Collection` 论文计数胶囊（挂载时 `ensureCollectionSummaryHydrated()` 并经 `subscribeCollectionSummary` 订阅，hover 显示分源统计或空池提示）、Agent / 模型选择（`survey-agent-picker.tsx`，交互同 Deep Search） |
| 左栏 Composer | `plaza-survey-view.tsx` | 自上而下与引导三步一致：(1) 种子论文选择（`flex-1 min-h-[10rem]`）、(2) 主题输入（`Ctrl/⌘+Enter` 开始）、(3) 格式单选卡（短段落 / 长报告）、(4) 开始按钮与论文池为空时的轻量提示（复用 `plaza.discover.poolEmptyHint`，不挂常驻错误条）；宽度与草稿在本次应用会话内保留 |
| 种子论文选择 | `survey-paper-picker.tsx` | 读 `libraryStore.papers`（进入时 `ensureSurveyLibraryLoaded()`），按标题 / 作者 / 年份 / 期刊多词过滤并支持一键清除搜索词，`@tanstack/react-virtual` 虚拟列表；已选以可移除 chip 显示，按论文 `path` 标识 |
| 右栏结果 | `survey-run-view.tsx` | 当前运行：头部（主题、格式、种子数 hover 列表、时间、耗时、导出按钮、填入左侧编辑 `PenLine`、停止 / 重跑 / 两次点击删除），运行中显示阶段条 + 工具调用 Trace + 折叠的思考；结束后为结果卡与折叠的过程记录 |

无活动运行时右栏显示三步引导（选择论文 → 确定主题 → 选择格式）与最近 4 条历史。任意运行均可通过头部的「填入左侧编辑」（`onLoadToComposer`）一键将种子论文、主题与格式写回左栏 Composer 继续微调。

## 结果呈现

- **短段落**：一张卡片（小节标题 + 段落）。每句的引用渲染为「来源图标 + 编号」小标记（论文库 / 论文集 / 外部三种色调），放在句末标点之前；hover 显示论文卡（标题、作者、年份 · 期刊、来源徽标、摘要），可打开论文库论文（`openPaper(joinVaultPath(vault, libraryPath))`）、打开 DOI / arXiv / URL、复制 `\cite{key}`。卡片底部为按首次引用顺序编号的参考文献列表。操作：复制 LaTeX、复制 BibTeX、运行头部导出 `.tex + .bib`（`exportSurveyLatex`，`\cite` key 与 `.bib` 完全一致）。
- **长报告**：一张宽版长卡片（`max-w-4xl`），运行头部提供显式的「导出 HTML」按钮（`exportSurveyReport`），卡片头部显示标题、摘要、参考文献数与显式的「在系统浏览器打开」按钮（`openSurveyReport`）；正文为 `survey-report-frame.tsx` 中的文档画框（外层 `bg-muted/25 p-3 sm:p-4` 底衬包裹 `overflow-hidden rounded-lg border bg-white shadow-xs` 白底纸面 `srcdoc` iframe），按文档高度自适应，在亮 / 暗主题下均保持清晰的 A4 纸张层次。

### 报告 iframe 安全约定

`sandbox="allow-same-origin"`，**不**含 `allow-scripts`：报告中的任何脚本都不会执行；同源仅用于父页面测量高度（`ResizeObserver`，上限 24000px 防止 `100vh` 无限增长）与接管链接点击——`#ref-KEY` 锚点滚动外层面板（尊重 `prefers-reduced-motion`），`http(s)` 链接交给系统浏览器。报告 HTML 不应使用视口相对高度。

## 数据层

入口 `src/lib/plaza/survey-store.ts`（zustand `usePaperSurveyStore`，运行记录持久化于 `plaza:survey:runs:v1`，最多 30 条；应用重启时仍在运行的记录转为 `cancelled`），共享类型 `survey-types.ts`。失败统一由 store 以 `notifyError` Toast 提示，界面不挂常驻错误条；失败运行在结果区显示一次性的错误说明与重跑入口。

| 环节 | 实现 |
|---|---|
| Agent 会话 | `runOnce` + workflow `plaza_survey`（`survey-prompt.ts` 的 `SURVEY_WORKFLOW`）。Host 侧 `src-tauri/src/features/agent/session/run.rs` 为该 workflow 挂载 `agentero-collection` MCP 并使用无 Vault 的 cwd；`prompt/envelope.rs` 注入综述专用系统文本（只用 Collection 工具，无 Deep Search 的 tray / curate 规则）。会话 `hideFromChatHistory`，可取消、删除、重跑 |
| 种子上下文 | `survey-context.ts`：前端预先拼好元数据 + 摘要（≤2500 字符）+ 仅 Introduction 一节（每篇 ≤6000 字符、总预算 48k），Agent 不读全文。`readIntroduction` 优先扫描 `<paper>/source/`（深度 ≤ 2，跳过图表附件目录，最多读取 25 个 `.tex`/`.ltx`），经 `extractTexIntroduction` 去注释、定位主 `.tex`、展开 `\input` / `\include`（深度 ≤ 2），截取英文 / 中文引言小节（含子节，直至下一 `\section` 或 `\end{document}`；若无主文件引言则回退独立 `intro*.tex`），剥离图表环境与排版宏；若无 LaTeX 源码则回退读取 `<paper>/PAPER.md` |
| 输出契约 | `survey-prompt.ts`：最终回复以一个 ```` ```survey-json ```` 围栏块结束（段落：句子 + cite id；报告：另附完整 HTML，正文与表格单元格用 `[[cite:ID]]` 记号，遵循 A4 排版与 `@page { size: A4 }` 打印规则、内联 SVG 图表 + 对比表格，控制在 ≤4 页 A4 预算内）；`survey-parse.ts` 容忍前后散文并给出 `parseError.*` 错误码 |
| 引用与论文库优先去重 | `survey-store.ts` + `survey-export.ts`：引用元数据由前端从论文库 / 论文集解析，不信任模型。`mergeCitationWithLibrary` 将论文集 / 外部引用与种子论文及 `libraryStore.papers`（按 DOI、无版本号 arXiv ID 或 Unicode 归一标题）匹配合并；当种子引用与论文集 ID 指向同一篇论文时，保留 `source: "library"`、`libraryPath` 与 `preferredKey`（`bibtex_key`），同时补齐论文集更完整的 `upstreamBibtex`、摘要、期刊及卷期页码。BibTeX key 缺省为 `lastnameYearFirstword`（冲突追加 a/b 后缀），`.tex` 中 `\cite{key}` 与 `.bib` 完全一致；导出 `.tex + .bib` 时对用户所选父目录调用 `vaultAllowFsScope` 放行跨盘符写入（如 Windows `D:\`），先写 `.bib` 并在 `.tex` 的 `\bibliography{}` 提示中使用实际 bib 文件名 |
| 报告 HTML 存储、预览与导出 | `sanitizeReportHtml` 去除脚本、`on*` 处理器、`javascript:`、远程 / 协议相对资源与视口相对高度，并注入 `html,body{height:auto}`；引用为 `<a class="cite" href="#ref-KEY">`，参考文献为 `<li id="ref-KEY">`。规范文件存于 `<vault>/.agentero/surveys/`（无 Vault 或只读时回退应用数据目录），`src-tauri/capabilities/default.json` 为 `$APPDATA/surveys/**` 与 `$APPCACHE/surveys/**` 放行 `fs:scope`；`writeReportHtml`、`loadSurveyReportHtml` 与 `removeSurvey` 对非 `remote:` Vault 先调用 `vaultAllowFsScope` 支持跨盘符读写；系统浏览器打开前复制到 `$APPCACHE/surveys/<runId>.html`（匹配 opener `allow-open-path`）；`exportSurveyReport` 通过保存对话框导出独立 `.html` 文件并提示 `plaza.survey.exportedReport` |

## i18n

全部文案在 `sidebar.json` 的 `plaza.survey.*`（含 `exportReport`、`exportedReport`、`editInComposer` 等）；论文池统计与空池提示复用 `plaza.discover.poolSummary` / `plaza.discover.poolEmptyHint` / `plaza.collection.*`，Agent / 模型选择与「思考」沿用 `plaza.discover.*`，「在系统浏览器打开」沿用 `plaza.openInSystemBrowser`。
