//! Session-scoped `agentero-collection` stdio MCP server for Plaza Paper Discover (Deep Search).
//!
//! Re-executes the desktop binary with [`COLLECTION_MCP_WORKER_ARG`] and the
//! `<cache>/agentero/plaza-collection` directory path, exposing read-only
//! discovery, uniform random sampling, citation/co-citation snowballing, and
//! candidate curation strictly bounded to the user's `Paper Collection`.

use std::path::PathBuf;

use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};
use agentero_core::features::paper::discovery::collection_pool::{
    collection_cache_dir, compute_overview, curate_collection, read_snapshot_in, search_collection,
    snowball_citations_in_collection, CollectionCitationsOut, CollectionCitationsParams,
    CollectionCurateOut, CollectionCurateParams, CollectionOverviewOut, CollectionSearchOut,
    CollectionSearchParams, COLLECTION_MCP_WORKER_ARG,
};
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};

use crate::core::error::AppError;

#[derive(Clone)]
struct CollectionMcp {
    cache_dir: PathBuf,
    #[allow(dead_code)]
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

impl CollectionMcp {
    fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            tool_router: Self::tool_router(),
        }
    }

    fn load_snapshot(
        &self,
    ) -> Result<
        agentero_core::features::paper::discovery::collection_pool::CollectionSnapshot,
        AppError,
    > {
        read_snapshot_in(&self.cache_dir)
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
        let snapshot = self.load_snapshot().map_err(tool_err)?;
        Ok(Json(compute_overview(&snapshot)))
    }

    #[tool(
        description = "Search the local Paper Collection over title + abstract + keywords with boolean syntax (`AND` by space, `\"exact phrase\"`, `OR`, `-exclude`) and advanced filters (`ccfRanks`, `venues`, `categories`, `venueKind`, `venueDomain`, `dateFrom`, `dateTo`). Set `mode: \"random_sample\"` (`sampleSize: 50`) on the initial turn to uniformly sample up to 50 matching papers for unbiased method taxonomy analysis; set `mode: \"ranked\"` for targeted multi-turn narrowing."
    )]
    async fn collection_search(
        &self,
        Parameters(args): Parameters<CollectionSearchParams>,
    ) -> Result<Json<CollectionSearchOut>, CallToolResult> {
        let snapshot = self.load_snapshot().map_err(tool_err)?;
        Ok(Json(search_collection(&snapshot, &args)))
    }

    #[tool(
        description = "Snowball related papers strictly inside the local Paper Collection from 1-5 seed `paperIds`. Resolves outgoing `references`, incoming `cited_by`, and shared-reference `cocited` lineages, returning ONLY papers present in Paper Collection along with `relationType`, `linkedSeedIds`, and `via` explanations."
    )]
    async fn collection_citations(
        &self,
        Parameters(args): Parameters<CollectionCitationsParams>,
    ) -> Result<Json<CollectionCitationsOut>, CallToolResult> {
        let snapshot = self.load_snapshot().map_err(tool_err)?;
        let out = snowball_citations_in_collection(&self.cache_dir, &snapshot, &args).await;
        Ok(Json(out))
    }

    #[tool(
        description = "Publish structured candidate paper groups and 3-5 clickable follow-up direction pills to the Deep Search UI (`groups`, `mode`: `\"replace\"` or `\"append\"`, `suggestedFollowUps`). Every paper ID is verified against Paper Collection; call this whenever you present categorized or refined paper recommendations."
    )]
    async fn collection_curate(
        &self,
        Parameters(args): Parameters<CollectionCurateParams>,
    ) -> Result<Json<CollectionCurateOut>, CallToolResult> {
        let snapshot = self.load_snapshot().map_err(tool_err)?;
        Ok(Json(curate_collection(&snapshot, args)))
    }
}

#[tool_handler]
impl ServerHandler for CollectionMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "agentero-collection is a read-only MCP server over the user's local Plaza Paper Collection. \
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
    let dir = collection_cache_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("prepare plaza-collection cache dir: {e}")))?;
    let exe = std::env::current_exe().map_err(|error| {
        AppError::message(format!("locate agentero for collection mcp: {error}"))
    })?;
    let stdio = McpServerStdio::new("agentero-collection", exe).args(vec![
        COLLECTION_MCP_WORKER_ARG.to_string(),
        dir.display().to_string(),
    ]);
    Ok(McpServer::Stdio(stdio))
}

/// Exit into the stdio server when spawned with `--agentero-collection-mcp <cache_dir>`.
/// Returns `None` on normal desktop launch.
pub fn try_run_collection_mcp() -> Option<i32> {
    let mut args = std::env::args();
    let _argv0 = args.next();
    if args.next().as_deref() != Some(COLLECTION_MCP_WORKER_ARG) {
        return None;
    }
    let Some(cache_dir) = args.next() else {
        eprintln!("agentero-collection: missing cache directory path");
        return Some(2);
    };
    if args.next().is_some() {
        eprintln!("agentero-collection: unexpected extra arguments");
        return Some(2);
    }
    match serve(PathBuf::from(cache_dir)) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("agentero-collection: {error}");
            Some(1)
        }
    }
}

fn serve(cache_dir: PathBuf) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("start collection mcp runtime: {error}"))?;
    runtime.block_on(async move {
        let server = CollectionMcp::new(cache_dir)
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
