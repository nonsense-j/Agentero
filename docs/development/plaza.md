# 广场（Plaza）— 外部来源发现

> 范围：侧栏虚拟节点 **广场** 及其子来源（Cool Papers / ModelScope 论文 / Papers with Code / Skill 推荐 / 订阅 / 播客 / 论文推荐）；中间栏发现流。  
> 相关：[`../frontend/vault-tree.md`](../frontend/vault-tree.md)、[`../backend/paper-import.md`](../backend/paper-import.md)、[`../backend/index.md`](../backend/index.md)。  
> 订阅 MVP（已落地）：[`plaza-feeds.md`](plaza-feeds.md)。  
> 开关：设置 → 通用 → **广场**（`plazaEnabled`，默认开）；关闭后不显示、不加载。
> 单来源显隐：`plazaHiddenSources`（默认空）。右键广场父节点列出全部来源逐条勾选显隐（菜单保持打开可连续操作）；侧栏子行按此过滤。

## 0. 产品结论（2026-07-25，2026-08-14 修订）

| # | 议题 | 结论 |
|---|---|---|
| Q1 | 树位置 | **Library + Recycle Bin 下方、真实 Vault 根目录上方**（已实现） |
| Q2 | Cool Papers 呈现 | **内嵌 iframe + Host 代理协议** `agentero-coolpapers://`（已实现；见 §3.2） |
| Q3 | 入库 | **已实现**：每行注入 `[入库]`，复用现成魔棒（见 §3.2.1） |
| Q4 | P0 范围 | **已交付：广场壳 + Cool Papers 浏览入库 + Skill 推荐 + 订阅 + arXiv Daily**；播客尚未实现 |
| Q5 | ModelScope 论文 | **已实现**：同一代理模式，但站点是 SPA，另有取舍（见 §3.5） |
| Q6 | 订阅 | **已落地**：广场下单一原生节点，本地 RSS/Atom；见 [`plaza-feeds.md`](plaza-feeds.md) |

**已实现落点（2026-08-14）**

| 区域 | 路径 |
|---|---|
| 来源注册表 | `src/lib/plaza/sources.ts`（新增来源 = 一条数组项；`icon` 只存名称键，组件映射在 `src/components/plaza/source-icons.ts`） |
| 中间栏 | `src/components/plaza/plaza-view.tsx`、`plaza-web-frame.tsx`、`plaza-skills-view.tsx` |
| Skill 精选 | `src/lib/plaza/skill-catalog.ts` |
| 入库 | `src/lib/plaza/import.ts`（论文 + Skill 仓库） |
| 侧栏行 | `src/components/sidebar/file-tree/tree-rows.tsx`（`PlazaRow` / `PlazaSourceRow`） |
| Tab kind | `src/lib/workspace/tabs/types.ts` 的 `"plaza"` + `doc-view.tsx` 分支 |
| 站点代理（共享管道） | `src-tauri/src/features/paper/discovery/proxy/mod.rs` |
| 站点代理（各站改写 + 注入） | `src-tauri/src/features/paper/discovery/coolpapers/proxy.rs`、`src-tauri/src/features/paper/discovery/proxy/modelscope.rs`、`src-tauri/src/features/paper/discovery/proxy/pwc.rs` |

> Kimi 解析没有走广场入库，而是作为论文侧的独立能力落在 Markdown 工具栏的
> 「获取 Cool Paper 笔记」按钮上（`paper_coolpapers_notes` → 追加 `NOTES.md`）。
> 解析顺序：`source_url` 上的 papers.cool 链接 → venue 形 catalog id（`38818@AAAI`）
> → arXiv id → 标题（允许搜索结果截断后的长前缀）。

## 1. 产品动机

Agentero 已是 **local-first 论文工作台**（Library + 文件树 + PDF\|NOTES）。用户还需要从 **外部发现流** 找新论文。

**广场** = 「发现入口」集合，与 **Library（已收藏）** 正交：

| | Library | 广场 |
|---|---|---|
| 数据权威 | catalog + Vault 文件 | 外部站点 / 本地启发式；**P0 不写 Vault** |
| 侧栏 | `agentero:library` | `agentero:plaza` + 子来源 |
| 中间栏 | 论文库表格 | 来源专属发现 UI |
| 典型动作 | 打开 / 标签 / 导出 | 浏览发现 + 单条入库 |

来源：

1. **Cool Papers**（[papers.cool](https://papers.cool/)）— P0：内嵌站点浏览。  
2. **ModelScope 论文**（[modelscope.cn/papers](https://modelscope.cn/papers)）— 内嵌站点浏览；魔搭每日读论文带中文摘要与评分。  
3. **Skill 推荐** — 原生面板：按论文阅读 / 写作 / 绘图 / PPT 制作 / 复现 / 投稿精选 GitHub Skill 仓库；点卡片走魔棒 Skill 导入。  
4. **订阅** — 用户自己的 RSS / Atom / JSON Feed；论文条目入库。见 [`plaza-feeds.md`](plaza-feeds.md)。  
5. **播客** — 占位，后续。  
6. **论文推荐** — P0 v0：基于本地库的轻量推荐列表（无云端上传）。  
7. **CCF 截稿** — 原生面板：只读上游 [ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) 数据，按截稿时间列出 CCF A/B/C 会议；见 §3.6。
8. **Papers with Code** — 内嵌站点浏览（`https://paperswithcode.co/conferences`）：会议页、accepted papers、SOTA 榜单与方法索引；入口默认落在会议列表，每行注入「入库」。入库时的 arXiv 录用/代码仓库补全走同一上游 API，见 [`../backend/academic-search-apis.md`](../backend/academic-search-apis.md) §2.12。

## 2. 侧栏信息架构

```
📁 VaultName
├── 📚 Library                 agentero:library
├── 🗑️ Recycle Bin             agentero:trash
├── 🌐 广场                     agentero:plaza              ← 可折叠
│   ├── ✨ Cool Papers         agentero:plaza/cool-papers
│   ├── ✨ ModelScope 论文      agentero:plaza/modelscope
│   ├── 🏛️ Papers with Code     agentero:plaza/papers-with-code
│   ├── ✨ Skill 推荐           agentero:plaza/skills
│   ├── 📡 订阅                 agentero:plaza/feeds
│   ├── 🎙️ 播客                 agentero:plaza/podcasts      ← 占位
│   ├── 🔭 arXiv Daily            agentero:plaza/arxiv-rec
│   └── 📅 CCF 截稿               agentero:plaza/ccf-deadlines
├── papers/
├── notes/
└── …
```

| 项 | 约定 |
|---|---|
| 路径 | `agentero:plaza`、`agentero:plaza/<sourceId>`；**永不落盘** |
| 位置 | Library 与 Recycle Bin **之下**，真实根目录 **之上** |
| 父节点 | 单击 → 只切换展开/收起（纯虚拟文件夹，无广场首页） |
| 子节点 | 单击 → 对应来源 panel（dockview 虚拟 tab） |
| 右键 | 父节点：列出全部来源逐条勾选显隐（写入 `plazaHiddenSources`，菜单保持打开）；来源行无菜单；无删除/拖拽/Finder |
| 禁用 | 拖入拖出、删除、重命名、终端打开 |

**图标（建议）**

| 节点 | Lucide | en | zh-CN |
|---|---|---|---|
| 广场 | `Globe` | Plaza | 广场 |
| Cool Papers | `Flame` 或自定义标 | Cool Papers | Cool Papers |
| ModelScope 论文 | 自定义标（魔搭 favicon） | ModelScope papers | ModelScope 论文 |
| Papers with Code | `Landmark` | Papers with Code | Papers with Code |
| Skill 推荐 | `Sparkles` | Skill picks | Skill 推荐 |
| 订阅 | `Rss` | Feeds | 订阅 |
| 播客 | `Podcast` | Podcasts | 播客 |
| arXiv Daily | `Telescope` | arXiv Daily | arXiv Daily |

i18n：`sidebar:plaza.*`。

## 3. 中间栏呈现

### 3.1 壳：`PlazaView`

- dockview：`kind: "plaza"`，`path` = 虚拟 URI；同一 path 单实例 `activatePanel`。  
- **无**独立应用顶栏（与 Library 一致）；来源工具条做在内容区内。  
- 父路径 `agentero:plaza` **没有页面**：广场根只是文件树里的虚拟文件夹，单击只切换展开/收起；每个来源面板由子节点各自打开。

### 3.2 Cool Papers（P0，WebView）

**主内容**：内嵌 iframe，经 Host 代理协议 `agentero-coolpapers://localhost`（Windows 为 `http://agentero-coolpapers.localhost`）加载 papers.cool。

| 区域 | 行为 |
|---|---|
| 主体 | 全高 iframe；站点内导航、分区、搜索均由 papers.cool 负责 |
| 顶条（Agentero chrome） | 后退 / 前进 / 重新载入 / 当前路径（只读）/「系统浏览器打开」 |
| 站内链接 | 在 iframe 内直接跳转 |
| 站外链接 | 交给系统浏览器（arxiv.org 等一律拒绝被嵌套） |
| 加载失败 | 代理返回 502 文案 |
| 入库 | 每行 `[入库]`，见 §3.2.1 |

广场标签首次激活时才加载内容；切换标签或分栏焦点时保留已访问页面的实例与页面内状态，不受文档编辑器 LRU 淘汰影响。后台页面不会因此暂停脚本或网络请求，关闭标签或关闭广场功能时才释放。

关闭 Cool Papers 或 ModelScope 标签时 iframe 会销毁。应用按来源保存站内路径栈及其当前位置；两个代理页都按路由保存滚动位置，再次打开时恢复当前页面、后退 / 前进历史和阅读位置。Cool Papers 还会记录已点击 Kimi 的论文，并按间隔重新触发这些论文的总结请求。总结内容和排队状态仍由 papers.cool 提供；如果上游还在排队，内容会在上游生成后才能显示，应用不缓存总结正文。

**为什么要代理（`src-tauri/src/features/coolpapers/proxy.rs`）**

papers.cool 给几乎所有链接都加了 `target="_blank"`（单个分区页实测 238 处）。直接跨源嵌套时：

- 链接要么弹出独立窗口、要么静默失效——**点了没反应**；
- 跨源 iframe 的 `location` / `history` 都读不到，**无法实现后退**。

因此改为在 Host 侧以自有 scheme 转发（沿用 `discovery/proxy/arxiv.rs` 的既有模式），同源后即可改写与观测：

- `target="_blank"` → `_self`，站内链接原地跳转；
- **同时改写 `window.open`**。仅改 HTML 不够：cool.js 的所有脚本式跳转都走 `window.open`（搜索、`[REL]` 相关论文、排序、feed、导出收藏、arXiv 日历共 7 处），且多数传 `_blank`；sandbox 去掉 `allow-popups` 后这些调用会被**静默丢弃**，表现为「搜索点了没反应」。补丁在 `<head>` 安装，早于 body 末尾的 cool.js。
- 统一的三档跳转规则（链接与脚本共用）：**站内页面** → 原地 `location.assign`；**Atom feed** → 交系统浏览器（面板里渲染裸 XML 没有意义）；**跨源** → 交系统浏览器。
- feed 与站内 handoff 必须**换算回上游 origin** 再交出去——系统浏览器解析不了我们的私有 scheme（消息用 `externalPath`，由面板对 `homeUrl` 求解）。
- 绝对自链接 `https://papers.cool/…` → `/…`，导航不会掉出代理；
- 注入桥接脚本：`postMessage` 上报每次导航路径（前端据此维护 Back/Forward 栈），并拦截跨源链接交给系统浏览器；
- 上游 origin 在 Rust 侧**硬编码**，避免代理退化成任意 URL 中继（SSRF）。
- **只对完整 HTML 文档注入**（首字节是 `<!doctype` / `<html`）。`togglePdf` / `toggleKimi` 用 XHR 取的是 **同样标着 `text/html` 的片段**——Kimi 解析是裸 `<p class="faq-q">`，`POST /star` 是裸计数——cool.js 直接把响应文本塞进 DOM，一旦注入就会把脚本源码和计数当文本显示出来（现象：点 PDF / Kimi 弹出一段 `<script>…</script>0`）。
- **桥接脚本在嵌套 frame 内自我禁用**。pdf.js viewer 也是完整文档，会被一并注入；那里的 `parent` 是 papers.cool 页面而非应用，消息没人收，且点击拦截会把 PDF 内的链接 `preventDefault` 掉。判定方式：读 `parent.location.href`——面板自身的父窗口是跨源的应用会抛异常，嵌套 frame 的父窗口同源可读。

**其它工程注意**

- 前端不用 iframe 自身 history：一旦跳到第三方源就再次不可读；后退改为「按记录的路径重挂载 iframe」，因此也不会污染应用自身的 session history。
- **只有 后退 / 前进 / 重新载入 可以改变 iframe 的 `key`**（用单独的 `epoch` 计数器）。若把 `key` 挂到「观测到的导航」状态上（如 history 长度 / 游标），站内每次点击都会重挂载并重新加载**挂载时那个旧路径**，表现为「点子页面闪回首页」。venue 尤其明显：`<a onclick="listVenueDetail('AAAI')">` 无 href（只做 show/hide + `pushState('/')`），但其中的年份 / 分组是真链接 `href="/venue/AAAI.2026"`。
- sandbox 去掉 `allow-popups`，确保没有链接能逃到新窗口。
- 与 PDF iframe 一样，拖拽期间置 `pointer-events: none`，否则 dockview 收不到 dragover。
- 远程 Vault 会话下同样可用（广场不依赖 vault 文件 IO）。
- Host 用进程级复用的 HTTP 客户端转发（`core::http::shared_client`），否则每张图 / 每段 JS 都要重新握手代理 TLS，papers.cool 会明显卡。

### 3.2.1 入库（已实现）

代理注入的桥接脚本给每行论文标题追加 `[入库]`，与站点自带的 `[PDF] [Copy] [Kimi] [REL]` 同排。点击后把 `{ id, branch, url, title }` 交给面板，结果回传给该行显示 `[已入库]`。

**分两条路，因为质量不对等：**

| 行类型 | 路线 | 理由 |
|---|---|---|
| arXiv | 现成魔棒，喂 `arxiv.org/abs/{id}` | 原生 arXiv 路径还能多拿 `arxiv_id` 与 LaTeX 源码 |
| 其余（venue） | `paper_coolpapers_import`，读该行自己的 papers.cool 页面 | 不经 Translator；见下 |

**为什么 venue 不走 Translator。** papers.cool 的论文页自带 Highwire `citation_*`（title / authors / abstract / publisher / date，**以及 `citation_pdf_url`**），实测覆盖它聚合的全部 11 种出版商形态。而把出版商 URL 送去 Translator：

- `openreview.net`（COLM / CoRL / ICLR / ICML / MLSYS / NeurIPS / UAI **共 7 个 venue**）抓到的是 Cloudflare 人机验证页，0 作者；
- `ojs.aaai.org`（AAAI）HTTP 500；
- `www.ecva.net`（ECCV）HTTP 300 多选；
- `papers.miccai.org` / `www.ndss-symposium.org` 退化成 `webpage` / `blogPost`；
- **且 11/11 都不返回 PDF 附件。**

也就是说 Translator 那条路「一半站点坏、还全都缺 PDF、又多一跳依赖用户自建服务」，唯一净胜的只有 DOI（当前不填）。详见 [#333](https://github.com/poco-ai/Agentero/issues/333)。

**catalog id 用 papers.cool 原生 id**（如 `36962@AAAI`、`2026.acl-long.1@ACL`）。`allocate_paper_path` 不清洗 id、直接当目录名，`@` `.` 三平台合法。选它而非默认派生链是因为它全局唯一、去重精确；派生链的 `citekey_fallback`（`{姓}{年}{标题首词}`）会撞，而 `DedupePolicy::ByCatalogId` 撞了会**静默当重复吞掉**。代价是同一篇论文日后从 BibTeX / Zotero 进来 id 不同、会重复——已知取舍，原生 id 另存进 `source_url` 保留可追溯性。

**其它约定**

- 复用共享的 `paper_commit`：catalog 插入、NOTES.md 播种、PDF 下载、去重全部沿用，不新增管线。
- `paper_type` 不是 Zotero itemType，取值是 `PaperKind` 枚举（`arxiv` / `pdf` / `html` / `doi` / `other`）；无 DOI 时为 `other`。
- 元数据解析复用 `map_zotero_item_to_record`（先拼一个 Zotero 形状的值），避免第二套字段映射。
- 注入的 `[入库]` **不带 href**，否则会被跨源链接拦截器当外链送去系统浏览器。
- 行是滚动加载的（`loadMorePapers` 追加 `.panel.paper`），除首屏遍历外挂 `MutationObserver`。
- 只做**单条入库**，不提供批量。
- 入库后**不自动打开论文**，否则会把连续浏览的用户拽出面板。
- PDF 没取到时提示「已导入（未取到 PDF）」，不谎报干净成功。

**后续（非 P0）**：批量入库、预览抽屉；DOI 可按需回补（AAAI / IJCAI 的出版商页有 `citation_doi`，`/search` 按 DOI 的元数据质量最高）。

### 3.2.2 Skill 推荐（已实现）

原生面板（不 iframe）。六类：论文阅读 / 论文写作 / 绘图 / PPT 制作 / 复现 / 投稿。目录写在 `skill-catalog.ts`（静态 star 快照）。点卡片 → `importPlazaSkillRepo` → 魔棒 `lookupSubmit` → 现有 Skill 多选安装框。角上外链单独打开 GitHub。不含 Zotero / 文献库类仓库。

### 3.3 播客（占位）

- 空态文案：订阅源、单集列表与播放将在后续版本提供。  
- 侧栏子节点可点，进入占位页（避免「死链」）。

### 3.4 Paper Recommend（`agentero:plaza/arxiv-rec`，已实现）

**目标**：基于本地 `Paper Collection` 论文池按用户显式选择的关键词做无重复批次推荐（每次推送 15 篇），无需历史冗余视图，推荐状态直接落在论文池元数据上。

**两阶段交互流**（`src/components/plaza/plaza-arxiv-rec-view.tsx` + `src/lib/plaza/recommend-pool.ts`）：

1. **Stage 1 — 双区关键词选择页（`stage = "select"`）**：排布对齐 `Paper Discover` 门户页，默认停留在选择页（不自动触发推送；论文池刷新入口仅保留在 `Paper Collection` 内）：
   - **顶部标题栏**：左侧展示标题与 `Paper Collection` 论文池实时统计摘要，右上角固定放置主操作按钮 **`Recommend`**（选中至少 1 个关键词后激活）。
   - **上半区 `Recent Keywords`**：胶囊芯片（`magpie-chip`）展示常用与近期推荐过的关键词；支持任意芯片自由点选/取消（包括取消最后一个选中项至 0 选中）、一键清空已选、`X` 删除任意芯片，以及行内 `+` 添加自定义关键词。
   - **下半区 `All Keywords`（置顶 `Slider` + 下方词云）**：汇总本地 `Paper Collection` 全部论文经同义词归并后的规范化 `keywords`（`keyword-synonyms.ts` 与 Rust `paper_keywords` 双端一致归并单复数、连字符及核心共享词同义变体），**顶部固定 `Slider`**（`src/components/ui/slider.tsx`，范围 `15–150`，步长 `5`，默认 **Top 50**），**下方渲染交互词云**（字号按词频 `rem` 比例缩放），保证拖动滑块调节词云规模时滑块自身纵向位置始终固定不跳动。
   - **主操作 `Recommend`**：从 `Paper Collection` 中排除已推荐（`recommendedAt`）与已入库论文，将所选关键词归一至标准词后按精确/短语/词元匹配与发表时间新近度综合打分，取出 **15 篇**进入结果页，并将临时选中的词云词合并进 `Recent Keywords`。
2. **Stage 2 — 推荐结果页（`stage = "results"`，无历史列表）**：
   - **吸顶头部（`data-plaza-header`）**：左侧返回关键词选择页按钮 + 顶部展示本次所选关键词胶囊；右侧提供勾选批量入库、全选、一键翻译当前摘要（`runTranslate`）及「换一批（Next 15）」继续抽取下 15 篇未推荐论文。
   - **卡片流**：展示当前批次 15 篇论文，点击标题复用 `CollectionPaperDetailDialog` 查看完整摘要、关键词与 BibTeX，右侧支持应用内远程阅读 PDF（`openRemoteArxivPaper`）、打开原文及单条/批量入库（venue `coolPapersId` 走 `importPlazaPaper`，其余走 `lookupSubmit`）。

**元数据存储与性能优化**：

| 维度 | 机制 |
|---|---|
| 论文级元数据与词表持久化 | 已推荐状态直接记录在 `collection.sqlite` `papers.recommended_at`（前端映射为 `CollectionPaperItem.recommendedAt?: string`，ISO 时间戳），常用/已选词与滑块规模持久化于 `recommend_keywords` + `collection_config` 表；论文池刷新、合并与详情补全时始终保留既有 `recommended_at` |
| SQLite 原子推荐与零全量驻留 | 点击推荐或换一批时调用 `plaza_collection_recommend_next`，在 `collection.sqlite`（WAL）单事务内排除已推荐与已入库论文、将输入词按同义词表归一后计算关键词精确/短语/词元与发表新近度综合得分，仅返回当前批次 15 篇并原子写入 `recommended_at`，无需前端在 JS 堆内常驻数万篇全量论文池 |
| SQLite 词频聚合与 $O(1)$ 切片 | 词云由 `plaza_collection_word_cloud(topN: 150)` 直接基于归一后的 `paper_keywords` 表聚合返回预排序 Top-150 标准词频，前端拖动 `Slider`（15–150）本地切片为 $O(1)$，毫秒级响应且零全池遍历 |

> **附：后台 arXiv Daily 向量管线（供 `@` 引用预热）**：Host 侧 `src-tauri/src/features/recommend/mod.rs`（`recommend_arxiv` / `recommend_arxiv_last`，缓存表 `catalog.sqlite` `embed_cache` + `discovery_runs`）仍保留给 `vault:opened` 后台当日预热及 Agent `@` 引用广场条目使用；与命令行的无状态词法发现 `agentero discover arxiv`（见 [../backend/cli.md](../backend/cli.md#discover)）互不干扰。

### 3.5 ModelScope 论文（已实现）

**主内容**：内嵌 iframe，经 `agentero-modelscope://localhost` 加载 [modelscope.cn/papers](https://modelscope.cn/papers)。顶条 chrome、拖拽护盾、Back / Forward 全部复用 `PlazaWebFrame`，前端只多了 `PLAZA_SOURCES` 一条。

**浏览状态恢复**：重开面板时恢复 ModelScope 最近访问的论文路由、站内后退 / 前进历史，以及该路由下文档和 `.ms-page-container` 的滚动位置。路由由 umi 的 `pushState` 更新，因此滚动位置也在每次站内路由切换时分别保存。

**必须代理**：站点回 `X-Frame-Options: SAMEORIGIN`，直接 iframe 会被拒。代理重建响应时只保留 `Content-Type`，XFO 顺带被丢掉。

**与 Cool Papers 的四处不同（都因为它是 umi 3.5.26 SPA）**

| 差异 | 后果 |
|---|---|
| 列表走 `PUT /api/v1/dolphin/papers`（JSON body，匿名可用） | 代理原本只发 GET 且丢 body，页面会渲染成空壳。请求管道抽到 `discovery/proxy/mod.rs` 并**转发 method + body**（顺带修好 papers.cool 的 `POST /star`）。只转发 `Content-Type` / `Accept` / `Accept-Language`——`Cookie`、`Origin`、`Referer` 一律不带 |
| 外壳资源全是协议相对 `//g.alicdn.com/…`，含 `window.publicPath` | 在自有 scheme 下会解析成 `agentero-modelscope://g.alicdn.com/…`，应用根本不启动。`rewrite_html` 把 `="//` / `='//` / `= "//` 一律改成 `https://`。CDN 资源**不经代理**，否则等于给代理开一批额外上游主机（SSRF 面） |
| 路由是 `history.pushState`，点卡片不产生真实导航 | 桥接必须包装 `pushState` / `replaceState` 并监听 `popstate` 才能上报路径，否则顶条路径和 Back / Forward 永远不动 |
| 页面是 React，被拒绝的点击不能只 `preventDefault` | umi 的 `Link` 自己就会 `preventDefault` 然后照样路由，必须在捕获阶段 `stopImmediatePropagation`，让事件根本到不了 React 根容器 |

**只允许 `/papers*` 原地浏览。** 其余同域路径（`/models`、`/datasets`、`/docs`…）与站外链接一律 handoff 到系统浏览器；同域的走 `externalPath` 换算回上游 origin。登录一族（`/login`、`/register`、`/reset`、`/binding`）是另一套独立应用，本就不该在代理里跑——我们不注入任何登录态（§7）。

**隐藏站点 header**（`header.antd5-layout-header`）。面板是论文流，不是浏览器：全局导航只提供「走出去」的入口，还带登录按钮。隐去之后页面自带的搜索框、`本周热门 / 最新推荐 / 全部论文` 排序 tab 与卡片栅格都还在，面板反而更干净。

**面板适应与缩放**：广场 iframe 工具栏提供缩小、放大和百分比按钮；点击百分比恢复自动适应。ModelScope 使用来源注册表声明的 1280px 虚拟桌面宽度，默认随面板宽度等比缩小（不自动放大），侧栏收放和分屏调整都会更新；其他来源保持自然响应式布局。手动缩放为 25%–200%，保持到标签关闭；放大超出面板时由宿主的外层滚动口横向平移，iframe 内的触控板/Shift+滚轮余量经桥接 `panX` 消息交给宿主，不依赖浏览器跨 frame 的链式滚动。Ctrl/Cmd+滚轮和触控板捏合也按比例缩放；普通滚轮/双指滑动仍保持滚动与横滑。手势由 ModelScope 代理桥接转成 `zoomRatio` 消息，其他 iframe 来源暂只用工具栏按钮。缩放只调整 iframe 元素的尺寸与 transform，不读取跨域文档、不重载页面，后台隐藏标签保留上次有效尺寸。普通 HTML 阅读器与 PDF 缩放不在此范围。实现与 DOM 回归见 `src/components/plaza/use-plaza-frame-zoom.ts`、`test/plaza-frame-zoom.test.ts`。

**桌面宽度 + 横滑（站点代理层）**：论文页把布局钉在 1280px（`.ms-page-*` 的 `min-width`、页面适配器的固定宽）。前端现在为其提供至少 1280px 的虚拟视口，再缩放到面板；手动放大超出面板的部分由宿主的外层滚动口浏览，frame 自己的文档在 1280 虚拟视口内通常没有横向余量。代理层既有的站内横滑和位置修正仍保留，用于站点内容自身发生溢出的情况。frame 的滚轮/触控板增量不会可靠地传到外层，桥接因此自己处理 `wheel`：首帧记下位置，若这一帧文档自己没横向移动（引擎不认横滚），就把累计的 `deltaX`（以及 Shift+滚轮）补到 `scrollLeft` 上；仍有消费不掉的余量时，通过 `{ source: "agentero-plaza", panX }` 消息交给宿主，由宿主滚动外层滚动口。**不取消事件**，所以斜向手势的纵向滚动照常，页内自己的横向滚动器也优先。站点加载时会对页面上的操作项调 `scrollIntoView({ block: "center", inline: "center" })`，在站点内容自身溢出时这会把整个文档拽到右侧、左边缘被推出视口（#550）；桥接包一层 `scrollIntoView`，把被它移动过的祖先的 `scrollLeft` 复原（只挡横向、纵向照常）。站点自己的 `.ms-page-container` 也是可脚本滚动的容器，会被浏览器停在右移 10px 处、吃掉卡片左边距，桥接禁掉它的平滑滚动并把它钉回 0。

**入库**：`/papers/<arxivId>` 本身就是全部所需身份，所以列表卡片和详情页注入的「入库」都只发 `{ id, branch: "arxiv", url: "https://arxiv.org/abs/<id>" }`，直接落到 §3.2.1 的 arXiv 路线（能多拿 `arxiv_id` 与 LaTeX 源码）。**没有新增任何 Rust 入库命令，前端 `import.ts` 零改动。**

两处都是带 Agentero 标的按钮，一眼能认出是我们的动作而不是站点自己的：

- **列表**：按钮与标题同处一层 flex 行（`.agentero-import-titlerow`）。标题自带宽度钳制与省略号，按钮不能塞进标题里，所以把两者并排，并把按钮高度设成标题的 `line-height`，让它居中在文字上。自带边框/圆角/中性灰底，浅色深色主题都成立。
- **列表**：只装饰标题能解析出文本叶子的卡片（`titleOf` 取卡内第一个纯文本子 `div`），并跳过指向当前页的锚点（详情页 tab 条）。这两条一起让装饰不会落到站点自己的导航锚点上。
- **详情页**：插在站点那排 `arXiv 原文 / PDF / Git` 的最左侧，并**在运行时借用 `arXiv 原文` 的 className**，所以尺寸与外观完全一致。定位靠那颗 arXiv favicon（`img[src*="arxiv.org"]`）——那排的类名是哈希的、文案是本地化的，图标 src 两者都不是。
- **图标**：品牌标缩到只剩那副铜色眼镜。完整的插画式 logo 在 14px（站点图标尺寸）下糊成一团。
- **必须在链接拦截器之前注册点击处理并整体吞掉事件**——卡片按钮就长在卡片自己的 `<a>` 里面，否则入库的同时会被路由带走。
- 文案挂在子 `span.agentero-import-label` 上，落态只改它，图标与借来的结构不会被 `textContent` 抹掉。
- 站点的 Emotion 类名（`acss-*`）每次发版重新哈希，**只能**用 `header.antd5-layout-header`、`a[href^="/papers/"]`、arXiv favicon 这类结构化钩子。
- React 重渲染会抹掉注入节点，`MutationObserver` 挂 `document.body` 补回来（debounce 100ms，避免自触发抖动）。
- 回执按 `data-paper-id` 遍历匹配：arXiv id 带 `.`，不能用 id 选择器。
- 刷新或重开页面时，按钮会重新画成「入库」。桥接把当前页的 id 用 `queryImported` 问宿主，宿主按论文库的 `arxiv_id`（以及文件夹名）回答 `importedIds`，版本号 `vN` 忽略。已入库的行直接标成「已入库」，避免重复点。

### 3.6 CCF 截稿（已实现）

**主内容**：原生面板（不 iframe），只读上游 [ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) 发布的数据，**不自建、不存储会议库**。

| 项 | 约定 |
|---|---|
| 数据源 | `https://ccfddl.com/conference/initial.json`（上游 CI 每次 push 重建：最新 + 即将到来的 editions，约 176 KB）；其 `archive` 字段指向内容哈希的历史部分（全部往届 editions）。两者合并即全集，**无重叠** |
| 数据语料 | `conferences[].confs[].timeline[]` 的 `deadline`（`TBD` 丢弃）；`rank.ccf` 取 A/B/C/N |
| 时区 | `confs[].timezone` 标签换算成瞬时（`AoE` = UTC-12，`PT` = UTC-8，`UTC±N`）；未知标签该项排最后且不给倒计时 |
| 预测 | 对**没有任何未来官方截稿**的 CCF A/B/C 会议，取最近一届截稿日 +1 年并保留星期几（多数会议锚定「某月第 N 个周四」）生成预计项，标记 `estimated`；为免僵尸会议与过远猜测，限定最近一届在 18 个月内、且预测落在未来 12 个月内。历史部分拉取为**尽力而为**：失败即静默降级为「仅官方截稿」 |
| 缓存 | 每次打开面板强制拉取（不提供刷新按钮）；失败时回退到 `localStorage` 里上次的结果并 `notifyError` |
| 呈现 | 单列「接下来要投什么」：单色 CCF 徽标（A 最重 → N 最轻的明度梯度，不用颜色）+ 会议名与年份 + 会议官网外链 + 原站本地截稿时间与时区标签 + 剩余天数（≤3 天加粗强调）；预计项额外带一枚弱化的「预计」角标（Tooltip 说明为往届推算），与官方项按时间混排。头部为半透明吸顶材质（`data-plaza-header`，随 `prefers-reduced-transparency` 退化为实底 + 细边框），默认开启「关注会议（Collection）」过滤（直接联动 `Paper Collection` 中配置的关注 `venues`），并支持 CCF 评级多选（A / B / C / N 可叠加，「全部」清空）及右上角一键切换 `ccfddl.com` 官网 |
| 落点 | `src/lib/plaza/ccf-deadlines.ts`（拉取 / 解析 / 缓存）、`src/components/plaza/plaza-ccf-deadlines-view.tsx`（面板） |

**为什么自建 UI 而非内嵌 ccfddl.top**：数据结构稳定（MIT，schema 3.0.x 带版本号）、CORS 全开、解析成本低；内嵌站点是 jQuery 老表格，且整站 `<base target="_blank">`，仍要写代理改写链接，等于付出代理成本却换不来可用 UI。

**不做**：不接上游 MCP、不做批量入库、不做日程提醒，面板只回答「评几级 / 什么时候截止 / 官网在哪」。预计项只是「近期可能截止」的提示，不做确定日期承诺，也不覆盖任何官方截稿。

### 3.7 Papers with Code（已实现）

**主内容**：内嵌站点（`agentero-pwc` 代理 → `https://paperswithcode.co/conferences`），浏览会议、accepted papers、SOTA 榜单与方法索引。

| 项 | 约定 |
|---|---|
| 代理 | `src-tauri/src/features/paper/discovery/proxy/pwc.rs`；丢弃 `X-Frame-Options`、绝对自链接改写为相对、`target="_blank"` → `_self` |
| 路由观测 | SPA 无真实导航：patch `pushState` / `replaceState` + `popstate`，每次路由变化上报 `{ path }`；面板的 Back / Forward 仍按路径重挂载 |
| 外链 | 站外链接与 `window.open` 一律交系统浏览器；`download` 链接同样外抛 |
| 入库 | 注入 `[入库]` 到两类稳定钩子：列表 `article.paper-card > h3.paper-title`、详情 `.action-row`；行 id 取自 `/paper/<id>`。点击上报 `{ importPaper: { id, url, title } }`，成功后按 `importedId` 标「已入库」；重载后通过 `queryImported` 批量回填状态 |
| Host 入库 | `paper_pwc_import` → `agentero_core::features::paper::discovery::pwc::import_paper`：取 `/api/v1/papers/{id}`，有 arXiv 版则用 arXiv id 作为文件夹并下载 PDF/TeX，没有则落 `pwc-<catalog id>` 与外部链接；复用 `paper_commit` 的去重与资产管线 |
| 失败 | 入库失败只把该行恢复为「入库」可重试；错误走任务面板 / `notifyError`，不在侧栏挂错误条 |

**不做**：不注入「批量入库」、不接管站点登录、不解析 `paperswithcode.co` 的搜索与榜单数据（面板只借它的 UI）。

### 3.8 Paper Collection（已实现）

**主内容**：原生双入口面板（`arXiv` 与 `Venue` 独立门户），维护本地优先的 2026 论文池（统一持久化于 XDG data `collection.sqlite`，WAL + 外置内容 FTS5 `papers_fts` + `citation_edges`），前端 `collection-store.ts` 仅持有轻量统计摘要（`CollectionStateSummary`）与当前分页切片，零 PDF 自动下载。

| 维度 | 机制 |
|---|---|
| 打开策略（纯手动刷新） | 打开 `Paper Collection`（以及进入 `arXiv` / `Venue` 或切换子栏目）时仅通过 `plaza_collection_state_get` / `plaza_collection_list_papers` 读取本地 `collection.sqlite` 摘要与首屏分页（列表行省略 `bibtex` 大字段，点击详情时再由 `plaza_collection_paper_get` 按需读取），**默认不触发任何网络探测、预加载或同步请求**；仅当用户显式点击 `arXiv` / `Venue` / 当前子栏目的刷新按钮（或列表底部「加载更多 arXiv 论文」）时才执行更新 |
| 后台任务调度与进度展示 | `arXiv`（`plazaArxivRefresh`）与 `Venue`（`plazaVenueRefresh`）各自作为一条独立本地后台任务接入左下角 `BackgroundTasksPanel`（经 `src/lib/plaza/collection-refresh.ts` 的 `collectionRefreshStore` 与 `runLocalActivity` 驱动，支持标签页卸载/重挂保持状态与 `AbortSignal` 取消）；任务行左侧显示当前活跃 Venue / arXiv 分类与页/条目子进度（`(subCompleted/subTotal)`），最后一段 `" · "` 之后固定显示总进度计数（如 `Venue 25/28`、`arXiv 1/3`），进度条、门户卡片与刷新按钮同步反映单调递增的总百分比 |
| `arXiv` 全量回填与增量同步 | 默认启用 `cs.SE`、`cs.CR`、`cs.PL`（`cs.AI` 可按需开启）。手动点击刷新时，已有水位线的分区先发单条 `max_results=1` 增量水位线探测（无更新零拉取，有更新仅拉取 `submittedDate` 差异窗口并补全元数据）；尚未完成历史回填（`!historyComplete`）时，`refreshArxivCollection` 前台等待 `preloadAll2026ArxivInBackground`（`perPage=1000`、`>= 3.25s` 串行限速、瞬时空白响应重试保护），以 `submittedDate:[202601010000 TO toStamp]` 按最旧 `<published>` 时间戳向后滑动窗口直至抵达 `2026-01-01`，实时持久化每类 `oldestSyncedPublishedAt`、`remoteTotal` 与 `historyComplete`；随后 `backfillMissingArxivKeywords` 对池内所有未达完整元数据标准（`!isPaperMetadataComplete`：缺非占位摘要或关键词为空）的 `arXiv` 论文做全池回填，**无任何 10 天发表时间截断** |
| `Venue` 主轨纯净化同步与扩展管理 | 内置 `VENUE_SPECS` 覆盖 28 个 2026 顶会/顶刊（统一由官网 `url` + 主轨 `tracks` 列表 + 可选 Agent 提示 `notes` 描述，无 DBLP 依赖），并支持在设置弹窗新增、编辑、删除自定义或内置 Venue（`agent` 模式携带 `tracks` 与 `notes` 交由用户 Agent 联网与搜论文扩展）。手动刷新时多渠道主轨过滤协同：(1) `papers.cool/venue/{slug}` 主轨过滤（`ACL` Long+Short、`ICML`/`ICLR`/`NeurIPS` Oral/Spotlight/Poster 且排除 `Position:`、`AAAI` 主技术轨）；(2) 合卷 SE 顶会（`ASE`、`ICPC`、`RE`、`SANER`、`ICSME`、`ESEM`）强制以 `conf.researchr.org` 主轨名录为准（失败或为空则报错阻断，支持终稿拼写微调模糊对齐）并融合 IEEE CSDL GraphQL / DataCite LIPIcs / OpenAlex / Crossref 摘要与 DOI；(3) 独立卷顶会与顶刊精确 DOI 前缀 / `PACMPL` `POPL`/`PLDI`/`OOPSLA1+OOPSLA2` / LNCS ISBN 过滤，期刊剔除社论、勘误、TOSEM `RCR Report` 及 `<=4` 页短评；(4) 尚未分配 DOI 的顶会官方主轨日程（`CCS 2026`、`ISSRE 2026` Research Track）+ `NeurIPS 2026` arXiv 录用检索；Smart Diff 自动跳过已具备完整摘要与标准关键词的既有记录 |
| 完整元数据保障、关键词 LLM 兜底与同义词归一 | 每篇 `arXiv` 与 `Venue` 论文统一以 `isPaperMetadataComplete`（真实非占位 `abstract` + 至少 1 个规范化 `keyword`）衡量完整性：(1) **摘要补全**：依次通过 arXiv Atom `id_list`、OpenAlex 倒排索引、Crossref、IEEE CSDL GraphQL、Semantic Scholar 及 Springer 公开落地页（`#Abs1-content`）补齐摘要；(2) **关键词管线（`OpenAlex -> Keyword LLM`）**：`arXiv` 先查 OpenAlex 批量 DOI（`10.48550/arxiv.<id>`）+ OAI-PMH `landing_page_url`（限流时降级 0-credit 单篇 DOI），未命中的论文直接交由可配置的关键词 LLM（支持 `OpenRouter` 预设与自定义 `Base URL` / `API Key` / `Model` 的 OpenAI 兼容 BYOK）基于标题与摘要批量提取关键词；`Venue` 先合并出版商作者关键词与 OpenAlex `work.keywords`，仍为空时同样交由同一关键词 LLM 兜底，详情按需补全（`enrichSinglePaperOnDemand`）对 `arXiv` 与 `Venue` 执行同一 LLM 兜底。单次刷新会话内记录已尝试 ID 防止未配置 Key 或 `429` 时死循环重试，仅在元数据完整后永久跳过，修改关键词 LLM 配置或再次手动刷新时可继续补齐未完整条目；(3) **共享词同义词归并**：`src/lib/plaza/keyword-synonyms.ts` 与 Rust 写库/查询层对单复数、连字符及核心共享词同义词簇做规范化归并，消除同篇重复近义标签与词云碎片；(4) **全文获取**：入库与全文 PDF 获取除 `papers.cool` 直链与 Unpaywall OA 外，支持 `设置 -> 通用 -> 网络 -> 机构代理 -> CARSI` 联邦登录及本机 `paper-search` CLI 兜底 |
| 落点 | `crates/agentero-core/src/features/paper/discovery/collection/`、`src-tauri/src/features/paper/discovery/collection_commands.rs`、`src/lib/plaza/collection-store.ts`、`src/lib/plaza/collection.ts`、`src/lib/plaza/collection-refresh.ts`、`src/lib/plaza/collection-enrichment.ts`、`src/lib/plaza/collection-venue-channels.ts`、`src/lib/plaza/keyword-synonyms.ts`、`src/lib/keyword-llm.ts`、`src/components/plaza/plaza-collection-view.tsx`、`src/components/plaza/collection-portal-hub.tsx`、`src/components/plaza/plaza-discover-view.tsx` |

## 4. 与其它模块

| 模块 | 关系 |
|---|---|
| Library | arXiv Daily 读 `paper_list` 当语料；缓存表 `embed_cache` / `discovery_runs` 落在 catalog（v6 + v8），不动 `papers` 表 |
| 魔棒 / 入库 | **已复用** `lookup_import_batch`：喂上游 URL，见 §3.2.1。订阅论文卡走同一条 |
| 订阅 | 独立 XDG `feeds.sqlite`，不进 catalog；见 [`plaza-feeds.md`](plaza-feeds.md) |
| 论文池 / 发现 / 推荐 | 独立 XDG `collection.sqlite`（WAL + FTS5 `papers_fts` + `citation_edges`），不进 catalog；`Fast Search`、关键词推荐与 `agentero-collection` Stdio MCP 直连同一 SQLite，零 `snapshot.json` 导出或 `IndexedDB` 副本 |
| PDF\|NOTES | 推荐打开本地论文时走现有阅读布局 |
| Agent | 订阅详情与 arXiv Daily 远程 PDF 均支持划词提问 / 加入对话（#421；远程 ephemeral，不写 `marks/`）；Agent `@` 可引用广场条目（arXiv Daily 当日 + Feeds 最近条目，元数据 + Vault 外全文临时副本展开进 prompt，见 [agent.md](../frontend/agent.md)） |
| 命令面板 | P1：`Plaza: Cool Papers` 等 |

## 5. 虚拟路径与类型草图

```ts
export const PLAZA_VIRTUAL_PATH = "agentero:plaza";

export const PLAZA_SOURCE_PATHS = {
  coolPapers: "agentero:plaza/cool-papers",
  podcasts: "agentero:plaza/podcasts",
  recommend: "agentero:plaza/recommend",
} as const;

export function isPlazaVirtualPath(path: string | null | undefined): boolean {
  return Boolean(path?.startsWith("agentero:plaza"));
}
```

DocTab：`kind: "plaza"`（或 `file` + mode `plaza` + path 虚拟 URI——实现时与 Library/Trash 对齐选一种，**推荐独立 kind** 便于 `DocView` 分支）。

## 6. 分阶段

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0a 壳** | 侧栏广场 + 三子节点；`PlazaView` 按来源路由 | 虚拟 path 不写盘；i18n；折叠位置正确 |
| **P0b Cool Papers** | WebView 浏览 papers.cool + 导航 chrome + 外链 | 可分区浏览站点；失败可恢复 |
| **P0c arXiv Daily** | embedding 相似度 + 时间衰减排序 + 一键入库（已交付） | 内置或自定义 embedding 任一可用时有排序结果；两者都没有时有引导空态 |
| **P0d 播客** | 占位页 | 可进入、文案清晰 |
| **P1** | 入库（解析 arXiv / 魔棒管线）、预览抽屉、批量加入 Library | 与魔棒语义一致 |
| **P2** | 播客实体、Agent 推荐、命令面板 | — |
| **P2 @ 广场条目（已交付）** | Agent `@` 搜索引用 arXiv Daily + Feeds 条目；虚拟路径 `agentero:plaza/…`，发送时展开元数据，并为 arXiv 条目准备 Vault 外全文临时副本（`<cache>/agentero/plaza-scratch/`，优先准备有效 LaTeX 并输出供 Agent 读取的 `SOURCE.txt`，明确无 TeX 才由正文引擎转 `PAPER.md`，500MB LRU、单篇下载上限 100MB、并发串行化；设置→关于可清除）；另有「今日推荐」整体引用：摘要目录 + `NEED_FULLTEXT` 两步编排（Agent 粗筛→自动取全文→续轮出报告） | 标题关键词可命中；Agent 读全文无需入库；条目过期 / 全文准备失败降级提示，不静默丢弃 |
| **订阅 MVP** | 原生面板 + 本地 RSS + 论文入库 | 见 [`plaza-feeds.md`](plaza-feeds.md) M1–M4 |

## 7. 明确不做（P0）

- 广场 → Vault **批量入库**（单条已实现，见 §3.2.1）。  
- 把 feed 写入 catalog（订阅条目缓存走 XDG，见 [`plaza-feeds.md`](plaza-feeds.md)）。  
- 播客播放器。订阅管理见 [`plaza-feeds.md`](plaza-feeds.md)，不进本篇原 P0。  
- 云端协同过滤，或把整个本地库上传到 Agentero 自有服务。arXiv Daily 只把**有摘要的论文条目**（title + abstract）发给当前 embedding 端点：默认是内置网关，用户可切到自己配置的 BYOK 端点，也可以留空把功能整个关掉（见 §3.4 取舍 · 隐私）。  
- 注入脚本只做导航上报与 `[入库]`；**不注入任何凭据 / API Key / 登录态**。

## 8. 实现落点（编码时）

| 区域 | 路径 |
|---|---|
| 设计 | `docs/development/plaza.md`（本文，UI 规范也在此，`docs/frontend/shell.md` 没有广场小节） |
| 虚拟 path | `src/lib/plaza/sources.ts` |
| 文件树 | `src/components/sidebar/file-tree/` |
| 中间栏 | `src/components/plaza/*` + `doc-view` |
| 站点内嵌 | `src/components/plaza/plaza-web-frame.tsx`（代理 iframe，两个站点来源共用；没有 Tauri 子 webview 封装） |
| arXiv Daily | `src-tauri/src/features/recommend/`（管线 + 命令）、`src/lib/recommend/index.ts`、`src/components/plaza/plaza-arxiv-rec-view.tsx`；缓存表见 `catalog/schema.rs` v6 |
| CCF 截稿 | `src/lib/plaza/ccf-deadlines.ts`、`src/components/plaza/plaza-ccf-deadlines-view.tsx`（只读上游 JSON，无 Host 侧代码） |
| Paper Collection / Discover | `crates/agentero-core/src/features/paper/discovery/collection/`（`collection.sqlite` + MCP 查询引擎）、`src-tauri/src/features/paper/discovery/collection_commands.rs`、`src-tauri/src/integration/collection_mcp.rs`、`src/lib/plaza/collection-store.ts`、`src/lib/plaza/collection.ts`、`src/lib/plaza/paper-search.ts`、`src/lib/plaza/recommend-pool.ts` |
| 订阅 | [`plaza-feeds.md`](plaza-feeds.md) §6 |
| i18n | `sidebar` / 独立 `plaza` ns |
| Roadmap / Todo | 增加「广场 P0」条目 |

## 9. 风险与后续确认点

| 风险 | 缓解 |
|---|---|
| 站点改版 / 禁止嵌入 | 代理已丢弃 `X-Frame-Options`；仍失败则把该来源降级为 `embedOrigin: null` + 「系统浏览器打开」 |
| ModelScope 换 API 形状或 header 类名 | 只依赖结构化钩子（`antd5-*`、`a[href^="/papers/"]`）；列表接口变了表现为空列表，代理无需改动 |
| alicdn 资源的 CORS | `crossorigin="anonymous"` 的几个脚本需要上游回 `*`；被拦时兜底是在 `rewrite_html` 里去掉 `crossorigin`（无 `integrity`，降级为经典脚本） |
| WebView 体积与内存 | 仅在对应 plaza panel 挂载；关 tab 销毁；Cool Papers / ModelScope 重开时恢复站内历史与阅读位置，Cool Papers 另恢复已请求的 Kimi 总结 |
| 推荐过冷启动 | 空态文案；阈值（如 &lt; 3 篇不估标签组） |

**仍可再确认（非阻塞 P0a）**：

- Cool Papers 默认落地 URL（首页 vs 某默认分区如 `cs.AI`）。  
- 推荐 v0 是否显示「打开过的非 paper 笔记」——默认 **否**，仅 paper 单元。

---

*修订：2026-07-25 — 采纳 WebView、不做入库、P0 含推荐 v0、树位置在 Library/Trash 下。*
*修订：2026-08-14 — 改为代理协议嵌入；壳 + Cool Papers 浏览 + 单条入库已落地；推荐 / 播客未实现。*
*修订：2026-10-08 — 新增 CCF 截稿来源：原生面板只读上游 ccf-deadlines 的 `initial.json`，见 §3.6。*
*修订：2026-10-08 — CCF 截稿面板按 Apple 设计语言重构：单色评级徽标、半透明吸顶分段筛选、剩余天数强调，去除手动刷新与时间戳。*
*修订：2026-10-08 — CCF 截稿新增「未官宣用往届推算」：合并 `initial.json` 的 `archive` 历史，对无未来官方截稿的 A/B/C 会议生成 `estimated` 预计项（+1 年保留星期几，18 个月 / 12 个月窗口），面板加「预计」角标。*
*修订：2026-08-15 — 新增 ModelScope 论文来源；请求管道抽到 `discovery/proxy/mod.rs` 并转发 method + body。*  
*修订：2026-08-15 — 订阅列为广场来源，规格拆到 [`plaza-feeds.md`](plaza-feeds.md)。*  
*修订：2026-08-15 — 订阅 MVP 落地（XDG `feeds.sqlite` + 原生双栏 + 论文入库）。*  
*修订：2026-08-21 — arXiv 推荐落地（embedding + 时间衰减；缓存进 catalog schema v6；`vault:opened` 预热）。*
*修订：2026-09-10 — arXiv Daily 的 embedding 凭据新增内置来源（`embedding.source`），新装默认走产品网关；隐私取舍与空态条件随之改写，见 §3.4。*
*修订：2026-11-11 — 广场 AI & SE 专项升级与 Paper Collection 双入口重构：*
- **默认 arXiv 分区**：`Paper Collection` 默认启用 `["cs.SE", "cs.CR", "cs.PL"]`（因 `cs.AI` 预印本数量极大，默认关闭并保留在设置弹窗顶部供按需勾选）；订阅芯片保留 `["cs.SE", "cs.CR", "cs.PL", "cs.AI"]`。
- **四大核心模块（`PLAZA_SOURCES`）**：
  1. **Paper Collection (`agentero:plaza/collection`)**：本地优先的 2026 论文池（`crates/agentero-core/src/features/paper/discovery/collection/` + `src/lib/plaza/collection-store.ts` + `src/lib/plaza/collection.ts` + `src/lib/plaza/collection-enrichment.ts` + `src/lib/plaza/collection-venue-channels.ts` + `src/components/plaza/plaza-collection-view.tsx`）。打开面板与切换子栏目默认不自动更新，仅从 XDG data `collection.sqlite` 读取轻量统计摘要与分页切片；首页上下排列 **`arXiv` 入口卡** 与 **`Venue` 入口卡**，两张卡片各自提供独立刷新按钮，进入子栏目（如 `cs.SE` 或 `ASE 2026`）后点击刷新仅刷新当前子栏目。手动刷新时，`arXiv` 先以 `max_results=1` 比对最新时间戳与 ID 水位线（无更新零拉取、有更新仅增量拉取 `submittedDate` 差异窗口并补全元数据，未完成全年回填的分区分页回填 `2026-Now` 至 `collection.sqlite` 池）；`Venue` 覆盖 PL/SE CCF-A/B 会议与期刊、CR CCF-A 会议、AI CCF-A 会议共 28 个 2026 顶会/顶刊，点击刷新时执行多渠道全量多页更新（去重按 `arXiv` 与各 `Venue` 门户隔离）；进入列表后顶部导航切换来源与子项，`arXiv` 专属提供 `2026-Now` / `30d` / `7d` 时间筛选，列表默认首屏分页拉取 100 篇、每次点击追加拉取 50 篇，点击任意卡片按需加载完整摘要、被引数量、关键词与引用/BibTeX 详情弹窗。
  2. **Paper Discover (`agentero:plaza/discover`)**：全部限定在本地 `Paper Collection` 池内进行检索与探索（零 PDF 自动下载，单条/批量入库复用 `lookupSubmit`）。初始落地页为双入口卡片页（`src/components/plaza/plaza-discover-view.tsx`），分别进入交互完全独立的两种模式：
     - **`Fast Search`**（`src/lib/plaza/paper-search.ts` + `src/components/plaza/discover-fast-view.tsx`）：经 `plaza_collection_search` 在 `collection.sqlite` 外置内容 FTS5 `papers_fts` 上执行 `title` + `abstract` + `keywords` 加权相关性与布尔检索语法（空格 `AND`、`\"精确短语\"`、`OR`、`-排除词`），配合可折叠高级搜索圈定时间范围（`7d`/`30d`/`90d`/`All`/自定义起止日期）、来源范围（`arXiv` 分区多选、`Venue` 会议/期刊、领域 `PL/SE`/`CR`/`AI`、具体顶会/顶刊多选）及可叠加等级芯片（`CCF-A`、`CCF-B`、`arXiv`）。
     - **`Deep Search`**（`src/lib/plaza/deep-discover-store.ts` + `src/components/plaza/discover-deep-view.tsx` + 会话级只读 Stdio MCP `agentero-collection` `src-tauri/src/integration/collection_mcp.rs` + `crates/agentero-core/src/features/paper/discovery/collection/`）：左侧为独立持久化的多轮 Agent 对话框（`workflow: "plaza_deep_discover"`，`hideFromChatHistory: true`），右侧为可折叠、可拖动分隔线调整宽度的论文托盘（`已选` / `本轮` / `历史` 三个 Tab：`本轮` 收录 Agent 当前轮回复提到的全部论文并按方法分组，用户发起新一轮后自动转入按轮次分组的 `历史`；勾选（或用户在对话中要求、Agent 以 `keep: true` 标记）的论文进入 `已选`，跨轮保留并以 `<selected_papers>` 块附带到下一条消息作为参考，亦可一键批量入库；卡片默认仅显示 header + 标题 + 作者 + 完整的一句话总结，点击总结或展开按钮查看摘要、关键词与滚雪球等操作）。`agentero-collection` 通过 WAL 直接连接 XDG data `collection.sqlite`（无需任何 `snapshot.json` 导出或全量 IPC 传输），向 Agent 暴露 4 个专用工具：`collection_overview`（池统计）、`collection_search`（`mode: "ranked"` 检索用于推荐的相关论文，`mode: "random_sample"` 仅在主题宽泛时抽样概览方法版图）、`collection_citations`（基于 OpenAlex / Semantic Scholar 引用与共引脉络缓存至 `citation_edges` 并映射回 `Paper Collection` 进行滚雪球搜索，100% 返回池内论文）及 `collection_curate`（每轮最终回复前提交回复中提到的全部论文：`groups[].items[{ id, reason, keep }]`、`unkeepIds`、`suggestedFollowUps`，校验池内 ID 后推送到托盘 `本轮`；输出 schema 中的列表字段始终序列化，避免 MCP 客户端以缺少 required 字段拒收）。
  3. **Paper Recommend (`agentero:plaza/arxiv-rec`)**：两阶段无重复推荐面板（见 §3.4）。首屏居中展示 `Recent Keywords` 胶囊芯片（可自由点选/取消至 0 选中、自定义增删）与汇总池内全部论文关键词的 `All Keywords` 词云（由 `plaza_collection_word_cloud` 聚合返回，默认 Top 50，置顶 `Slider` 支持 15–150 动态调节）；点击 `Recommend` 进入结果页，顶部展示已选关键词并经 `plaza_collection_recommend_next` 原子推送 15 篇未推荐论文，已推荐状态直接记录在 `collection.sqlite` `papers.recommended_at`（不维护冗余历史列表）。
  4. **CCF Deadline (`agentero:plaza/ccf-deadlines`)**：从 `ccfddl` 同步截稿日程，原生列表默认联动 `Paper Collection` 仅展示所关注会议的截稿倒计时，支持与内嵌 `https://ccfddl.com/` 网页视图一键切换。
*修订：2026-11-12 — Paper Collection 存储统一收敛至 XDG data `collection.sqlite`（WAL + FTS5 `papers_fts` + `citation_edges`）：移除前端 `IndexedDB` / `localStorage` 双写与 MCP `snapshot.json` 全量快照导出，前端改为轻量 `collection-store.ts` 分页读取，`agentero-collection` Stdio MCP 直连 `collection.sqlite` 读取与写回 `citation_edges`。*
*修订：2026-11-13 — 论文池完整元数据保障与关键词同义词归一：`arXiv` 与 `Venue` 统一采用 `OpenAlex -> Keyword LLM（OpenRouter 预设 / OpenAI 兼容 BYOK）` 关键词提取管线并移除 10 天回填窗口截断，对全部缺摘要或空关键词论文补齐完整元数据，同时在前端与 Rust `paper_keywords` 层接入共享词同义词规范化归并。*
