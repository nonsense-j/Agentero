# Windows WebView2 子窗口失效触发 `tauri-plugin-log` 无限递归写盘

**状态**：已修复（`TargetKind::Webview` 过滤 `tauri_runtime_wry` / `wry` target）
**影响面**：Windows 开发构建（`cfg!(debug_assertions)` 开启 `TargetKind::Webview`）—— 当任一辅助 WebView2 窗口（如 Settings、外部 CARSI / OAuth 登录弹窗或独立功能窗）因页面调用 JS `window.close()` 或销毁竞态进入失效态时，任意后续日志会触发无限自放大错误循环，高速写满 stdout 与轮转日志文件。
**相关代码**：

- `src-tauri/src/app/logging.rs` — `build_log_plugin()`、`should_forward_to_webview()`

---

## 1. 现象

辅助 WebView2 窗口在页面侧执行 `window.close()` 后，主进程在下一条普通日志触发瞬间开始高速循环刷屏：

```text
[ERROR][tauri_runtime_wry] WebView2 error: WindowsError(Error {
  code: HRESULT(0x8007139F),
  message: "The group or resource is not in the correct state to perform the requested operation."
})
```

同时造成：
- 应用滚动日志目录（`%LOCALAPPDATA%/<identifier>/logs/agentero*.log`）每 ~90 秒写满一个 2 MB 轮转文件；
- 开发态标准输出在几十分钟内暴涨至数百 MB，伴随持续异常磁盘写入。

## 2. 根因

`tauri-plugin-log` 的 `TargetKind::Webview` 通过 `app.emit("log://log", ...)` 向所有已注册的 WebView 广播每一条 Rust 日志，底层在 Windows 上调用 `ICoreWebView2::ExecuteScript`：

1. 辅助 WebView2 的 COM 控制器失效（例如页面侧 `window.close()` 销毁了内部 WebView2 但 Tauri 窗口表项尚未移除，或销毁竞态）；
2. 任意普通日志进入 `TargetKind::Webview` → 对失效 WebView2 调 `ExecuteScript`；
3. WebView2 返回 `HRESULT(0x8007139F)`（`ERROR_INVALID_STATE`）；
4. `tauri_runtime_wry` 用 `log::error!(target: "tauri_runtime_wry", ...)` 记录该错误；
5. 该 `error!` 再次被 `tauri-plugin-log` 投递给 `TargetKind::Webview` → 再次向失效 WebView2 调 `ExecuteScript` → 再次报错，形成**无上限自放大递归死循环**。

## 3. 修复与约束

在 `src-tauri/src/app/logging.rs` 中为 `Target::new(TargetKind::Webview)` 挂载 `.filter(...)`，拒绝将 `tauri_runtime_wry`、`wry` 及其子 target 回送到 WebView：

- 真实发生的单次 `tauri_runtime_wry` / `wry` 错误仍照常写入 `Stdout` 与 `LogDir`，不丢失诊断信息；
- 错误不再回流到 `TargetKind::Webview`，彻底斩断递归放大路径。

**开发约束**：
- 关闭 Tauri 托管窗口始终使用 Tauri Window API（`getCurrentWindow().close()`）或原生关闭按钮，避免在调试脚本中直接执行页面 `window.close()`；
- 任何向 WebView 转发日志的 sink（`TargetKind::Webview` 或自定义 `Dispatch`）都必须排除底层 WebView 运行时自身的日志 target（`tauri_runtime_wry` / `wry`）。
