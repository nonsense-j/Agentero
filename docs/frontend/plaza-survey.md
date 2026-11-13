# 广场 · 论文综述（Paper Survey）

虚拟路径 `agentero:plaza/survey`，注册于 `src/lib/plaza/sources.ts`（`panel: "survey"`，图标 `PlazaSurveyIcon`）。用户从论文库选出种子论文、给定具体主题、选择输出格式，由 ACP Agent 阅读种子论文核心内容并在本地论文集（`agentero-collection` MCP）中检索相关工作后撰写结果。

## 入口与布局

| 区域 | 组件 | 说明 |
|---|---|---|
| 顶栏 | `plaza-survey-view.tsx` | 标题、历史切换（Popover，可删除）、新建综述、Agent / 模型选择（`survey-agent-picker.tsx`，交互同 Deep Search） |
| 左栏 Composer | `plaza-survey-view.tsx` | 主题（`Ctrl/⌘+Enter` 开始）、格式单选卡（短段落 / 长报告）、种子论文选择、开始按钮；宽度与草稿在本次应用会话内保留 |
| 种子论文选择 | `survey-paper-picker.tsx` | 读 `libraryStore.papers`（进入时 `ensureSurveyLibraryLoaded()`），按标题 / 作者 / 年份 / 期刊多词过滤，`@tanstack/react-virtual` 虚拟列表；已选以可移除 chip 显示，按论文 `path` 标识 |
| 右栏结果 | `survey-run-view.tsx` | 当前运行：头部（主题、格式、种子数 hover 列表、时间、耗时、停止 / 重跑 / 两次点击删除），运行中显示阶段条 + 工具调用 Trace + 折叠的思考；结束后为结果卡与折叠的过程记录 |

无活动运行时右栏显示引导（三步）与最近 4 条历史。

## 结果呈现

- **短段落**：一张卡片（小节标题 + 段落）。每句的引用渲染为「来源图标 + 编号」小标记（论文库 / 论文集 / 外部三种色调），放在句末标点之前；hover 显示论文卡（标题、作者、年份 · 期刊、来源徽标、摘要），可打开论文库论文（`openPaper(joinVaultPath(vault, libraryPath))`）、打开 DOI / arXiv / URL、复制 `\cite{key}`。卡片底部为按首次引用顺序编号的参考文献列表。操作：复制 LaTeX、复制 BibTeX、导出 `.tex + .bib`（`exportSurveyLatex`，`\cite` key 与 `.bib` 完全一致）。
- **长报告**：一张长卡片，头部为标题、摘要、参考文献数与「在系统浏览器打开」（`openSurveyReport`）；正文为 `survey-report-frame.tsx` 中的 `srcdoc` iframe，按文档高度自适应。

### 报告 iframe 安全约定

`sandbox="allow-same-origin"`，**不**含 `allow-scripts`：报告中的任何脚本都不会执行；同源仅用于父页面测量高度（`ResizeObserver`，上限 24000px 防止 `100vh` 无限增长）与接管链接点击——`#ref-KEY` 锚点滚动外层面板（尊重 `prefers-reduced-motion`），`http(s)` 链接交给系统浏览器。报告 HTML 不应使用视口相对高度。

## 数据层

入口 `src/lib/plaza/survey-store.ts`（zustand `usePaperSurveyStore`，运行记录持久化于 `plaza:survey:runs:v1`，最多 30 条；应用重启时仍在运行的记录转为 `cancelled`），共享类型 `survey-types.ts`。失败统一由 store 以 `notifyError` Toast 提示，界面不挂常驻错误条；失败运行在结果区显示一次性的错误说明与重跑入口。

| 环节 | 实现 |
|---|---|
| Agent 会话 | `runOnce` + workflow `plaza_survey`（`survey-prompt.ts` 的 `SURVEY_WORKFLOW`）。Host 侧 `src-tauri/src/features/agent/session/run.rs` 为该 workflow 挂载 `agentero-collection` MCP 并使用无 Vault 的 cwd；`prompt/envelope.rs` 注入综述专用系统文本（只用 Collection 工具，无 Deep Search 的 tray / curate 规则）。会话 `hideFromChatHistory`，可取消、删除、重跑 |
| 种子上下文 | `survey-context.ts`：前端预先拼好元数据 + 摘要（≤2500 字符）+ 仅 Introduction 一节（从论文目录 `PAPER.md` 截到下一节为止，每篇 ≤6000 字符、总预算 48k），Agent 不读全文 |
| 输出契约 | `survey-prompt.ts`：最终回复以一个 ` ```survey-json ` 围栏块结束（段落：句子 + cite id；报告：另附完整 HTML，正文用 `[[cite:ID]]` 记号）；`survey-parse.ts` 容忍前后散文并给出 `parseError.*` 错误码 |
| 引用与 BibTeX | `survey-export.ts`：引用元数据由前端从论文库 / 论文集解析，不信任模型；按 doi / arXiv / 标题身份去重；key 为 `lastnameYearFirstword`，冲突追加 a/b 后缀；`.tex` 中 `\cite{key}` 与 `.bib` 完全一致。导出先写 `.bib`，`.tex` 的 `\bibliography{}` 提示使用实际 bib 文件名 |
| 报告 HTML | `sanitizeReportHtml` 去除脚本、`on*` 处理器、`javascript:`、远程 / 协议相对资源与视口相对高度，并注入 `html,body{height:auto}`；引用为 `<a class="cite" href="#ref-KEY">`，参考文献为 `<li id="ref-KEY">`。规范文件存于 `<vault>/.agentero/surveys/`（无 Vault 时为应用数据目录）；打开前复制到 `$APPCACHE/surveys/<runId>.html`，因为 opener 的 `allow-open-path` 只放行该 glob（`src-tauri/capabilities/default.json`） |

## i18n

全部文案在 `sidebar.json` 的 `plaza.survey.*`；Agent / 模型选择与「思考」沿用 `plaza.discover.*`，「在系统浏览器打开」沿用 `plaza.openInSystemBrowser`。
