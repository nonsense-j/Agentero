//! Session-scoped `agentero-collection` stdio MCP server for Plaza Paper Discover (Deep Search).
//!
//! Re-executes the desktop binary with [`COLLECTION_MCP_WORKER_ARG`] and the
//! `collection.sqlite` path under `agentero_data_dir()`, reading directly over
//! SQLite WAL for zero-copy discovery, uniform random sampling, citation/co-citation
//! snowballing, and candidate curation strictly bounded to the user's `Paper Collection`.

use std::path::PathBuf;

use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};
use agentero_core::features::paper::discovery::collection::{
    collection_db_path, curate_collection_at, ensure_collection, overview_at, search_collection_at,
    snowball_citations_at, CollectionCitationsOut, CollectionCitationsParams, CollectionCurateOut,
    CollectionCurateParams, CollectionOverviewOut, CollectionSearchOut, CollectionSearchParams,
    COLLECTION_MCP_WORKER_ARG,
};
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};

use crate::core::error::AppError;

#[derive(Clone)]
struct CollectionMcp {
    db_path: PathBuf,
    #[allow(dead_code)]
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

impl CollectionMcp {
    fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            tool_router: Self::tool_router(),
        }
    }
}

fn tool_err(err: impl std::fmt::Display) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(err.to_string())])
}

#[tool_router]
impl CollectionMcp {
    #[tool(
        description = "Inspect summary statistics of the local Paper Collection pool: total papers, arXiv vs Venue counts, date range, CCF-A/CCF-B distribution, arXiv categories, and configured conferences/journals."
    )]
    async fn collection_overview(&self) -> Result<Json<CollectionOverviewOut>, CallToolResult> {
        let db = self.db_path.clone();
        let out = tokio::task::spawn_blocking(move || overview_at(&db))
            .await
            .map_err(tool_err)?
            .map_err(tool_err)?;
        Ok(Json(out))
    }

    #[tool(
        description = "Search the local Paper Collection over title + abstract + keywords with boolean syntax (`AND` by space, `\"exact phrase\"`, `OR`, `-exclude`) and advanced filters (`ccfRanks`, `venues`, `categories`, `venueKind`, `venueDomain`, `dateFrom`, `dateTo`). Set `mode: \"ranked\"` (default) for the most relevant matches to recommend; set `mode: \"random_sample\"` (`sampleSize` <= 50) to uniformly sample matches when surveying the method landscape of a broad topic."
    )]
    async fn collection_search(
        &self,
        Parameters(args): Parameters<CollectionSearchParams>,
    ) -> Result<Json<CollectionSearchOut>, CallToolResult> {
        let db = self.db_path.clone();
        let out = tokio::task::spawn_blocking(move || search_collection_at(&db, &args))
            .await
            .map_err(tool_err)?
            .map_err(tool_err)?;
        Ok(Json(out))
    }

    #[tool(
        description = "Snowball related papers strictly inside the local Paper Collection from 1-5 seed `paperIds`. Resolves outgoing `references`, incoming `cited_by`, and shared-reference `cocited` lineages, returning ONLY papers present in Paper Collection along with `relationType`, `linkedSeedIds`, and `via` explanations."
    )]
    async fn collection_citations(
        &self,
        Parameters(args): Parameters<CollectionCitationsParams>,
    ) -> Result<Json<CollectionCitationsOut>, CallToolResult> {
        let out = snowball_citations_at(&self.db_path, &args)
            .await
            .map_err(tool_err)?;
        Ok(Json(out))
    }

    #[tool(
        description = "Publish this turn's papers to the user's paper tray. Call it before your final reply with EVERY paper the reply mentions, grouped by method / sub-problem (`groups: [{ label, items: [{ id, reason, keep }] }]`); repeated calls in one turn merge. `reason` is the one-sentence summary shown on the paper card. Set `keep: true` only when the user explicitly asks to select / keep a paper; put IDs the user wants removed from their selection in `unkeepIds`. Add 3-5 `suggestedFollowUps` pills. IDs are verified against Paper Collection; unknown IDs are returned in `droppedUnknownIds`."
    )]
    async fn collection_curate(
        &self,
        Parameters(args): Parameters<CollectionCurateParams>,
    ) -> Result<Json<CollectionCurateOut>, CallToolResult> {
        let db = self.db_path.clone();
        let out = tokio::task::spawn_blocking(move || curate_collection_at(&db, args))
            .await
            .map_err(tool_err)?
            .map_err(tool_err)?;
        Ok(Json(out))
    }
}

#[tool_handler]
impl ServerHandler for CollectionMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "agentero-collection is a SQLite-backed MCP server over the user's local Plaza Paper Collection. \
                 All searches (`collection_search`), citation/co-citation snowballs (`collection_citations`), \
                 and curated recommendations (`collection_curate`) are strictly bounded to papers in this pool. \
                 Never fabricate paper IDs or search outside this server.",
            )
            .with_server_info(Implementation::new(
                "agentero-collection",
                env!("CARGO_PKG_VERSION"),
            ))
    }
}

/// Build the ACP stdio descriptor for attaching `agentero-collection` to a local Deep Search session.
pub fn collection_mcp_server() -> Result<McpServer, AppError> {
    let _conn = ensure_collection()?;
    let db_path = collection_db_path();
    let exe = std::env::current_exe().map_err(|error| {
        AppError::message(format!("locate agentero for collection mcp: {error}"))
    })?;
    let stdio = McpServerStdio::new("agentero-collection", exe).args(vec![
        COLLECTION_MCP_WORKER_ARG.to_string(),
        db_path.display().to_string(),
    ]);
    Ok(McpServer::Stdio(stdio))
}

/// Exit into the stdio server when spawned with `--agentero-collection-mcp <db_path>`.
/// Returns `None` on normal desktop launch.
pub fn try_run_collection_mcp() -> Option<i32> {
    let mut args = std::env::args();
    let _argv0 = args.next();
    if args.next().as_deref() != Some(COLLECTION_MCP_WORKER_ARG) {
        return None;
    }
    let Some(db_path) = args.next() else {
        eprintln!("agentero-collection: missing collection.sqlite path");
        return Some(2);
    };
    if args.next().is_some() {
        eprintln!("agentero-collection: unexpected extra arguments");
        return Some(2);
    }
    match serve(PathBuf::from(db_path)) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("agentero-collection: {error}");
            Some(1)
        }
    }
}

fn serve(db_path: PathBuf) -> Result<(), String> {
    let settings_store = crate::features::system::settings::AppSettingsStore::load();
    if let Ok(res) = settings_store.get() {
        let _ = crate::core::http::configure_proxy(
            res.settings.network_proxy_enabled,
            &res.settings.network_proxy_url,
        );
    }
    agentero_core::features::paper::scholar_api::client::set_openalex_api_key(
        settings_store.open_alex_key(),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("start collection mcp runtime: {error}"))?;
    runtime.block_on(async move {
        let server = CollectionMcp::new(db_path)
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|error| format!("collection mcp handshake: {error}"))?;
        server
            .waiting()
            .await
            .map_err(|error| format!("collection mcp stopped: {error}"))?;
        Ok(())
    })
}
