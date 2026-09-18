import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { access, realpath, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, } from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import * as z from "zod/v4";
import { isArtifactDownloadSupportedPlatform, registerArtifactTools, } from "./artifact-tools.js";
import { loadConfig } from "./config.js";
import { createOpenAIIncomingArtifactAdapter, } from "./incoming-artifacts.js";
import { logEvent, requestIp, requestPath, } from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { compileMcpRegistrationSurface, createModernMcpServerAdapter, modernMcpAdapterErrorLogFields, } from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { getLocalAgentProviderAvailabilitySnapshot, } from "./local-agent-availability.js";
import { buildLocalAgentCatalog, buildLocalAgentProviderStatuses, formatLocalAgentProviderStatusSummary, } from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import { contentText, logFailedToolResponse, logToolCall, resultOutputSchema, textBlock, workspaceAppDescriptorMeta, } from "./tool-surfaces/shared.js";
import { WORKSPACE_APP_URI, toolNames, workspaceIdDescription, } from "./tool-surfaces/types.js";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const gitCommand = process.platform === "win32" ? "git.exe" : "git";
const rgCommand = process.platform === "win32" ? "rg.exe" : "rg";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pythonCommand = process.platform === "win32" ? "python.exe" : "python3";
function mcpServerInfo() {
    return {
        name: "devspace",
        title: "DevSpace",
        version: DEVSPACE_VERSION,
        description: "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspace_id.",
    };
}
class ToolActivityTracker {
    active = new Set();
    track = (operation) => {
        const promise = operation();
        this.active.add(promise);
        const remove = () => this.active.delete(promise);
        void promise.then(remove, remove);
        return promise;
    };
    async waitForIdle() {
        while (this.active.size > 0) {
            await Promise.allSettled(Array.from(this.active));
        }
    }
}
function serverInstructions(config, toolSurface) {
    const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
        ? " When the user provides an attached or generated file that needs to be added to the workspace, pass the provided file directly to download_artifact with the existing workspace_id and a suitable relative destination path. Do not reconstruct attached files manually."
        : "";
    const showChangesInstruction = " For simple edits performed with edit_file_fast or write_file_fast, use the returned change summary and do not call show_changes unless the user explicitly asks for a full diff. For other file modifications, call show_changes once after the final related change and before the final response.";
    const skills = config.skillsEnabled
        ? `When ${toolNames.openWorkspace} returns available skills and a task matches one, use ${toolNames.read} with the returned skill path before proceeding. `
        : "";
    const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in available_agents_files, use ${toolNames.read} to inspect that instruction file and follow it. `;
    const common = `Use the smallest number of MCP calls. For project discovery use project_snapshot_fast. For several known files use multi_read_fast. For multiple search terms use project_search_fast; for one search use search_files_fast. For Git overview use git_summary_fast. For several exact edits use multi_edit_fast; for one exact edit use edit_file_fast. For a small explicit file creation/overwrite use write_file_fast. For combined verification use run_checks_fast. Use list_directory_fast/read_file_fast/git_status_fast only for narrow single-purpose requests. Call ${toolNames.openWorkspace} only for broader coding work, complex refactors, arbitrary shell execution, or isolated worktrees, then reuse its workspace_id and never reopen the same workspace unnecessarily.`;
    return `${common} ${toolSurface.instructions({ agents, skills })}${artifactInstruction}${showChangesInstruction}`;
}
function formatVisibleAgent(agent) {
    const model = agent.model ? `, model ${agent.model}` : "";
    const effort = agent.effort ? `, effort ${agent.effort}` : "";
    return `${agent.name} (${agent.provider}${model}${effort})`;
}
function formatAvailableAgentProvider(provider) {
    const details = [
        provider.model ? `model ${provider.model}` : undefined,
        provider.effort ? `effort ${provider.effort}` : undefined,
        provider.note,
    ].filter(Boolean).join(", ");
    return `${provider.id}${details ? ` (${details})` : ""}`;
}
const workspaceSkillOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
});
const workspaceAgentsFileOutputSchema = z.object({
    path: z.string(),
    content: z.string(),
});
const workspaceLocalAgentOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    provider: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
});
const workspaceLocalAgentProviderOutputSchema = z.object({
    id: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
    note: z.string().optional(),
});
const workspaceAvailableAgentsFileOutputSchema = z.object({
    path: z.string(),
});
function sendJsonRpcError(res, status, code, message) {
    res.status(status).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
}
function requestLogFields(req, config) {
    return {
        ip: requestIp(req, config.logging.trustProxy),
        host: req.header("host"),
        userAgent: req.header("user-agent"),
        origin: req.header("origin"),
        referer: req.header("referer"),
        contentLength: req.header("content-length"),
    };
}
function assetBaseUrl(config) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}
function uiManifestUrl() {
    return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}
function readWorkspaceAppManifest() {
    return JSON.parse(readFileSync(uiManifestUrl(), "utf8"));
}
function getWorkspaceAppManifestEntry() {
    const manifest = readWorkspaceAppManifest();
    const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
    if (!entry?.file) {
        throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
    }
    return entry;
}
function assetUrl(baseUrl, assetPath) {
    return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}
function workspaceAppHtml(config) {
    const baseUrl = assetBaseUrl(config);
    const entry = getWorkspaceAppManifestEntry();
    const stylesheets = (entry.css ?? [])
        .map((stylesheet) => `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`)
        .join("\n");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}
function appCsp(config) {
    const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
    return {
        resourceDomains: [publicBaseUrl],
        connectDomains: [publicBaseUrl],
    };
}
function uiBuildDirectory() {
    return fileURLToPath(new URL("../dist/ui", import.meta.url));
}
function setAssetHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
async function assertWorkspaceAppAssets() {
    const entry = getWorkspaceAppManifestEntry();
    const candidates = [entry.file, ...(entry.css ?? [])].map((assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url));
    for (const candidate of candidates) {
        await access(candidate);
    }
}
export function createMcpServer(config, workspaces, reviewCheckpoints, processSessions, resolveLocalAgentProviders, incomingArtifactAdapters, trackToolActivity) {
    const toolSurface = getToolSurface(config.toolMode);
    const server = new McpServer(mcpServerInfo(), {
        instructions: serverInstructions(config, toolSurface),
    });
    registerMcpSurface(server, config, workspaces, reviewCheckpoints, processSessions, resolveLocalAgentProviders, incomingArtifactAdapters, trackToolActivity);
    return server;
}
function registerMcpSurface(server, config, workspaces, reviewCheckpoints, processSessions, resolveLocalAgentProviders, incomingArtifactAdapters, trackToolActivity) {
    const registrationTarget = trackToolActivity
        ? withTrackedToolHandlers(server, trackToolActivity)
        : server;
    const toolSurface = getToolSurface(config.toolMode);
    registerAppResource(registrationTarget, "DevSpace Diff Card", WORKSPACE_APP_URI, {
        description: "Interactive card for viewing DevSpace file diffs.",
        _meta: {
            ui: {
                csp: appCsp(config),
            },
        },
    }, async () => {
        await assertWorkspaceAppAssets();
        return {
            contents: [
                {
                    uri: WORKSPACE_APP_URI,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: workspaceAppHtml(config),
                    _meta: {
                        ui: {
                            csp: appCsp(config),
                        },
                    },
                },
            ],
        };
    });
    registerAppTool(registrationTarget, "list_directory_fast", {
        title: "List directory (fast)",
        description: "Fast read-only directory listing. Validates the requested directory against DevSpace allowedRoots and returns entries in one MCP call; use this instead of open_workspace + exec_command for simple listings.",
        inputSchema: {
            path: z.string().describe("Absolute directory path inside an allowed root."),
            depth: z.number().int().min(1).max(3).optional().describe("Directory depth, default 1, max 3."),
        },
        outputSchema: {
            root: z.string(),
            entries: z.array(z.object({
                path: z.string(),
                type: z.enum(["file", "directory"]),
            })),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path, depth }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const maxDepth = depth ?? 1;
        const entries = [];
        const walk = async (dir, level) => {
            const items = await readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const full = join(dir, item.name);
                const rel = relative(workspace.root, full) || item.name;
                if (item.isDirectory()) {
                    entries.push({ path: rel, type: "directory" });
                    if (level < maxDepth)
                        await walk(full, level + 1);
                }
                else if (item.isFile()) {
                    entries.push({ path: rel, type: "file" });
                }
            }
        };
        await walk(workspace.root, 1);
        const text = entries.map((entry) => `${entry.type === "directory" ? "[DIR]" : "[FILE]"} ${entry.path}`).join("\n");
        logToolCall(config, { tool: "list_directory_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text }],
            structuredContent: { root: workspace.root, entries },
        };
    });
    registerAppTool(registrationTarget, "read_file_fast", {
        title: "Read file (fast)",
        description: "Fast read-only text file read. Validates the file parent against DevSpace allowedRoots and returns its content in one MCP call; use this instead of open_workspace + read for simple reads.",
        inputSchema: {
            path: z.string().describe("Absolute text file path inside an allowed root."),
            max_chars: z.number().int().min(1024).max(200000).optional().describe("Maximum characters to return, default 50000."),
        },
        outputSchema: {
            path: z.string(),
            text: z.string(),
            truncated: z.boolean(),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path, max_chars }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path: dirname(path), mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const [rootReal, fileReal] = await Promise.all([realpath(workspace.root), realpath(path)]);
        const rootNorm = rootReal.toLowerCase();
        const fileNorm = fileReal.toLowerCase();
        if (!(fileNorm === rootNorm || fileNorm.startsWith(rootNorm + sep.toLowerCase())))
            throw new Error("Requested file resolves outside the validated workspace.");
        const limit = max_chars ?? 50000;
        const raw = readFileSync(fileReal, "utf8");
        const truncated = raw.length > limit;
        const text = truncated ? raw.slice(0, limit) : raw;
        logToolCall(config, { tool: "read_file_fast", workspaceId: workspace.id, path: fileReal, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text }],
            structuredContent: { path: fileReal, text, truncated },
        };
    });
    registerAppTool(registrationTarget, "search_files_fast", {
        title: "Search files (fast)",
        description: "Fast read-only filename or text search inside an allowed root. Performs workspace validation and search in one MCP call; prefer this over open_workspace + exec_command for simple searches.",
        inputSchema: {
            path: z.string().describe("Absolute directory path inside an allowed root."),
            query: z.string().min(1).max(500).describe("Text to search for."),
            mode: z.enum(["filename", "content"]).optional().describe("Search filenames or text content. Default content."),
            max_results: z.number().int().min(1).max(100).optional().describe("Maximum matches, default 30."),
        },
        outputSchema: {
            root: z.string(),
            matches: z.array(z.object({
                path: z.string(),
                line: z.number().int().optional(),
                preview: z.string().optional(),
            })),
            truncated: z.boolean(),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path, query, mode, max_results }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const searchMode = mode ?? "content";
        const limit = max_results ?? 30;
        const rgExe = rgCommand;
        const baseArgs = ["--color", "never", "--hidden",
            "-g", "!node_modules/**", "-g", "!.git/**", "-g", "!.venv/**",
            "-g", "!venv/**", "-g", "!__pycache__/**", "-g", "!.next/**",
            "-g", "!dist/**", "-g", "!build/**"];
        let output = "";
        try {
            const args = searchMode === "filename"
                ? [...baseArgs, "--files", workspace.root]
                : [...baseArgs, "--line-number", "--no-heading", "--fixed-strings", "--ignore-case", query, workspace.root];
            output = execFileSync(rgExe, args, { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
        }
        catch (error) {
            output = error?.stdout?.toString?.() ?? "";
        }
        let matches = [];
        if (searchMode === "filename") {
            matches = output.split(/\r?\n/).filter(Boolean)
                .filter((full) => full.toLowerCase().includes(query.toLowerCase()))
                .map((full) => ({ path: relative(workspace.root, full) }));
        }
        else {
            matches = output.split(/\r?\n/).filter(Boolean).map((line) => {
                const parsed = line.match(/^(.*?):(\d+):(.*)$/);
                if (!parsed)
                    return { path: line };
                return { path: relative(workspace.root, parsed[1]), line: Number(parsed[2]), preview: parsed[3].slice(0, 300) };
            });
        }
        const truncated = matches.length > limit;
        matches = matches.slice(0, limit);
        logToolCall(config, { tool: "search_files_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: matches.map((m) => `${m.path}${m.line ? ":" + m.line : ""}${m.preview ? "  " + m.preview : ""}`).join("\n") || "No matches." }],
            structuredContent: { root: workspace.root, matches, truncated },
        };
    });
    registerAppTool(registrationTarget, "git_status_fast", {
        title: "Git status (fast)",
        description: "Fast read-only git status for a repository inside an allowed root. Validates the repository and runs git status in one MCP call.",
        inputSchema: {
            path: z.string().describe("Absolute Git repository directory inside an allowed root."),
        },
        outputSchema: {
            root: z.string(),
            branch: z.string(),
            clean: z.boolean(),
            status: z.string(),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const gitExe = gitCommand;
        const branch = execFileSync(gitExe, ["-C", workspace.root, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim();
        const status = execFileSync(gitExe, ["-C", workspace.root, "status", "--short"], { encoding: "utf8", windowsHide: true }).trim();
        const clean = status.length === 0;
        logToolCall(config, { tool: "git_status_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: `Branch: ${branch || "(detached)"}\n${clean ? "Working tree clean." : status}` }],
            structuredContent: { root: workspace.root, branch, clean, status },
        };
    });
    registerAppTool(registrationTarget, "edit_file_fast", {
        title: "Edit file (fast)",
        description: "Fast exact text replacement in one file. Validates the file against allowedRoots, requires an exact old_string match count, and returns a compact change summary in one MCP call.",
        inputSchema: {
            path: z.string().describe("Absolute text file path inside an allowed root."),
            old_string: z.string().min(1).max(200000).describe("Exact text to replace."),
            new_string: z.string().max(200000).describe("Replacement text."),
            expected_replacements: z.number().int().min(1).max(100).optional().describe("Expected exact match count, default 1."),
        },
        outputSchema: {
            path: z.string(),
            replacements: z.number().int(),
            before_sha256: z.string(),
            after_sha256: z.string(),
            summary: z.string(),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ path, old_string, new_string, expected_replacements }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path: dirname(path), mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const [rootReal, fileReal] = await Promise.all([realpath(workspace.root), realpath(path)]);
        const rootNorm = rootReal.toLowerCase();
        const fileNorm = fileReal.toLowerCase();
        if (!(fileNorm === rootNorm || fileNorm.startsWith(rootNorm + sep.toLowerCase())))
            throw new Error("Requested file resolves outside the validated workspace.");
        const raw = readFileSync(fileReal, "utf8");
        const expected = expected_replacements ?? 1;
        const count = raw.split(old_string).length - 1;
        if (count !== expected)
            throw new Error(`Exact old_string match count was ${count}; expected ${expected}. File was not modified.`);
        const updated = raw.split(old_string).join(new_string);
        const beforeSha = createHash("sha256").update(raw).digest("hex");
        const afterSha = createHash("sha256").update(updated).digest("hex");
        writeFileSync(fileReal, updated, "utf8");
        const summary = `Replaced ${count} exact occurrence(s) in ${fileReal}. SHA256 ${beforeSha.slice(0, 12)} -> ${afterSha.slice(0, 12)}.`;
        logToolCall(config, { tool: "edit_file_fast", workspaceId: workspace.id, path: fileReal, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: summary }],
            structuredContent: { path: fileReal, replacements: count, before_sha256: beforeSha, after_sha256: afterSha, summary },
        };
    });
    registerAppTool(registrationTarget, "write_file_fast", {
        title: "Write file (fast)",
        description: "Fast create or explicit overwrite of a UTF-8 text file inside allowedRoots in one MCP call. Parent directory must already exist. Use normal workspace tools for complex refactors.",
        inputSchema: {
            path: z.string().describe("Absolute text file path inside an allowed root."),
            content: z.string().max(500000).describe("Complete UTF-8 file content, max 500k characters."),
            overwrite: z.boolean().optional().describe("Allow replacing an existing file. Default false."),
        },
        outputSchema: {
            path: z.string(),
            created: z.boolean(),
            bytes: z.number().int(),
            sha256: z.string(),
            summary: z.string(),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ path, content, overwrite }, { _meta }) => {
        const startedAt = performance.now();
        const parent = dirname(path);
        const { workspace } = await workspaces.openWorkspace({ path: parent, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const [rootReal, parentReal] = await Promise.all([realpath(workspace.root), realpath(parent)]);
        const rootNorm = rootReal.toLowerCase();
        const parentNorm = parentReal.toLowerCase();
        if (!(parentNorm === rootNorm || parentNorm.startsWith(rootNorm + sep.toLowerCase())))
            throw new Error("Requested parent directory resolves outside the validated workspace.");
        const leaf = relative(parent, path);
        if (!leaf || leaf.startsWith("..") || leaf.includes("/") || leaf.includes("\\"))
            throw new Error("Target must be a direct file path inside the validated parent directory.");
        const target = join(parentReal, leaf);
        let existed = true;
        try {
            await access(target);
        }
        catch {
            existed = false;
        }
        if (existed && !overwrite)
            throw new Error("Target file already exists. Set overwrite=true only when replacement is intended.");
        if (existed) {
            const targetReal = await realpath(target);
            const targetNorm = targetReal.toLowerCase();
            if (!(targetNorm === rootNorm || targetNorm.startsWith(rootNorm + sep.toLowerCase())))
                throw new Error("Existing target resolves outside the validated workspace.");
        }
        writeFileSync(target, content, "utf8");
        const sha = createHash("sha256").update(content).digest("hex");
        const bytes = Buffer.byteLength(content, "utf8");
        const summary = `${existed ? "Overwrote" : "Created"} ${target} (${bytes} bytes, SHA256 ${sha.slice(0, 12)}).`;
        logToolCall(config, { tool: "write_file_fast", workspaceId: workspace.id, path: target, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: summary }],
            structuredContent: { path: target, created: !existed, bytes, sha256: sha, summary },
        };
    });
    registerAppTool(registrationTarget, "multi_read_fast", {
        title: "Read multiple files (fast)",
        description: "Read multiple UTF-8 text files inside one validated workspace in a single MCP call. Best for inspecting a known set of small project files such as README, package.json, pyproject.toml, or config files.",
        inputSchema: {
            root: z.string().describe("Absolute project root inside an allowed root."),
            paths: z.array(z.string()).min(1).max(12).describe("Absolute file paths inside this project root."),
            max_chars_each: z.number().int().min(512).max(100000).optional().describe("Maximum characters per file, default 20000."),
        },
        outputSchema: {
            files: z.array(z.object({
                path: z.string(),
                text: z.string(),
                truncated: z.boolean(),
            })),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ root, paths, max_chars_each }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path: root, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const rootReal = await realpath(workspace.root);
        const rootNorm = rootReal.toLowerCase();
        const limit = max_chars_each ?? 20000;
        const files = [];
        for (const requested of paths) {
            const fileReal = await realpath(requested);
            const fileNorm = fileReal.toLowerCase();
            if (!(fileNorm === rootNorm || fileNorm.startsWith(rootNorm + sep.toLowerCase())))
                throw new Error(`Requested file resolves outside the validated workspace: ${requested}`);
            const raw = readFileSync(fileReal, "utf8");
            const truncated = raw.length > limit;
            files.push({ path: fileReal, text: truncated ? raw.slice(0, limit) : raw, truncated });
        }
        logToolCall(config, { tool: "multi_read_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: files.map((f) => `--- ${f.path} ---\n${f.text}${f.truncated ? "\n[truncated]" : ""}`).join("\n\n") }],
            structuredContent: { files },
        };
    });
    registerAppTool(registrationTarget, "project_snapshot_fast", {
        title: "Project snapshot (fast)",
        description: "Return a compact project overview in one MCP call: top-level entries, git branch/status when available, and common project files such as README/package.json/pyproject.toml/requirements.txt. Use this before broader project work.",
        inputSchema: {
            path: z.string().describe("Absolute project directory inside an allowed root."),
            max_chars_each: z.number().int().min(512).max(30000).optional().describe("Maximum characters per common file, default 8000."),
        },
        outputSchema: {
            root: z.string(),
            entries: z.array(z.object({ path: z.string(), type: z.enum(["file","directory"]) })),
            git: z.object({ available: z.boolean(), branch: z.string().optional(), status: z.string().optional() }),
            files: z.array(z.object({ path: z.string(), text: z.string(), truncated: z.boolean() })),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path, max_chars_each }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const root = workspace.root;
        const entries = (await readdir(root, { withFileTypes: true })).map((item) => ({
            path: item.name,
            type: item.isDirectory() ? "directory" : "file",
        }));
        let git = { available: false };
        try {
            const gitExe = gitCommand;
            const branch = execFileSync(gitExe, ["-C", root, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim();
            const status = execFileSync(gitExe, ["-C", root, "status", "--short"], { encoding: "utf8", windowsHide: true }).trim();
            git = { available: true, branch, status };
        }
        catch {
        }
        const candidates = ["README.md","README","package.json","pyproject.toml","requirements.txt","Cargo.toml","go.mod","pom.xml"];
        const limit = max_chars_each ?? 8000;
        const files = [];
        for (const name of candidates) {
            const candidate = join(root, name);
            try {
                await access(candidate);
                let raw = readFileSync(candidate, "utf8");
                if (name === "package.json") {
                    try {
                        const pkg = JSON.parse(raw);
                        raw = JSON.stringify({
                            name: pkg.name,
                            version: pkg.version,
                            scripts: pkg.scripts,
                            dependencies: pkg.dependencies,
                            devDependencies: pkg.devDependencies,
                        }, null, 2);
                    }
                    catch {
                    }
                }
                const truncated = raw.length > limit;
                files.push({ path: candidate, text: truncated ? raw.slice(0, limit) : raw, truncated });
            }
            catch {
            }
        }
        const parts = [
            `Root: ${root}`,
            `Entries:\n${entries.map((e) => `${e.type === "directory" ? "[DIR]" : "[FILE]"} ${e.path}`).join("\n")}`,
            git.available ? `Git branch: ${git.branch || "(detached)"}\nGit status:\n${git.status || "clean"}` : "Git: unavailable",
            ...files.map((f) => `--- ${f.path} ---\n${f.text}${f.truncated ? "\n[truncated]" : ""}`),
        ];
        logToolCall(config, { tool: "project_snapshot_fast", workspaceId: workspace.id, path: root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: parts.join("\n\n") }],
            structuredContent: { root, entries, git, files },
        };
    });
    registerAppTool(registrationTarget, "project_search_fast", {
        title: "Project search (fast)",
        description: "Search multiple terms across one project in a single MCP call using ripgrep. Returns compact grouped matches and skips heavy generated directories.",
        inputSchema: {
            path: z.string().describe("Absolute project directory inside an allowed root."),
            queries: z.array(z.string().min(1).max(300)).min(1).max(8),
            glob: z.string().max(200).optional().describe("Optional ripgrep glob such as *.py or src/**."),
            max_results_per_query: z.number().int().min(1).max(100).optional(),
        },
        outputSchema: {
            root: z.string(),
            results: z.array(z.object({
                query: z.string(),
                matches: z.array(z.string()),
                truncated: z.boolean(),
            })),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path, queries, glob, max_results_per_query }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const rgExe = rgCommand;
        const limit = max_results_per_query ?? 30;
        const results = [];
        for (const query of queries) {
            const args = ["--line-number", "--no-heading", "--color", "never", "--hidden",
                "-g", "!node_modules/**", "-g", "!.git/**", "-g", "!.venv/**", "-g", "!dist/**", "-g", "!build/**"];
            if (glob)
                args.push("-g", glob);
            args.push("--fixed-strings", query, workspace.root);
            let output = "";
            try {
                output = execFileSync(rgExe, args, { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
            }
            catch (error) {
                output = error?.stdout?.toString?.() ?? "";
            }
            const all = output.split(/\r?\n/).filter(Boolean);
            results.push({ query, matches: all.slice(0, limit), truncated: all.length > limit });
        }
        logToolCall(config, { tool: "project_search_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: results.map((r) => `## ${r.query}\n${r.matches.join("\n") || "No matches."}${r.truncated ? "\n[truncated]" : ""}`).join("\n\n") }],
            structuredContent: { root: workspace.root, results },
        };
    });
    registerAppTool(registrationTarget, "git_summary_fast", {
        title: "Git summary (fast)",
        description: "Return branch, short status, diff stat, changed files, and recent commits in one MCP call.",
        inputSchema: { path: z.string().describe("Absolute Git repository directory inside an allowed root.") },
        outputSchema: {
            root: z.string(), branch: z.string(), status: z.string(),
            diff_stat: z.string(), changed_files: z.array(z.string()), recent_commits: z.array(z.string()),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const gitExe = gitCommand;
        const run = (args) => execFileSync(gitExe, ["-C", workspace.root, ...args], { encoding: "utf8", windowsHide: true }).trim();
        const runOptional = (args) => {
            try { return run(args); } catch { return ""; }
        };
        const branch = runOptional(["branch", "--show-current"]);
        const status = run(["status", "--short"]);
        const diffStat = runOptional(["diff", "--stat"]);
        const changedFiles = status.split(/\r?\n/).filter(Boolean).map((x) => x.slice(3));
        const recentCommits = runOptional(["log", "-5", "--pretty=format:%h %s"]).split(/\r?\n/).filter(Boolean);
        logToolCall(config, { tool: "git_summary_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: `Branch: ${branch || "(detached)"}\n\nStatus:\n${status || "clean"}\n\nDiff stat:\n${diffStat || "none"}\n\nRecent commits:\n${recentCommits.join("\n")}` }],
            structuredContent: { root: workspace.root, branch, status, diff_stat: diffStat, changed_files: changedFiles, recent_commits: recentCommits },
        };
    });
    registerAppTool(registrationTarget, "multi_edit_fast", {
        title: "Edit multiple files (fast)",
        description: "Apply multiple exact text replacements across files in one validated workspace. All edits are prevalidated before writing; if a write fails, previous writes are rolled back.",
        inputSchema: {
            root: z.string().describe("Absolute project root inside an allowed root."),
            edits: z.array(z.object({
                path: z.string(),
                old_string: z.string().min(1).max(200000),
                new_string: z.string().max(200000),
                expected_replacements: z.number().int().min(1).max(100).optional(),
            })).min(1).max(20),
        },
        outputSchema: {
            files_changed: z.number().int(),
            replacements: z.number().int(),
            summaries: z.array(z.string()),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async ({ root, edits }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path: root, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const rootReal = await realpath(workspace.root);
        const rootNorm = rootReal.toLowerCase();
        const plans = [];
        let totalReplacements = 0;
        for (const edit of edits) {
            const fileReal = await realpath(edit.path);
            const fileNorm = fileReal.toLowerCase();
            if (!(fileNorm === rootNorm || fileNorm.startsWith(rootNorm + sep.toLowerCase())))
                throw new Error(`Path outside validated workspace: ${edit.path}`);
            const raw = readFileSync(fileReal, "utf8");
            const expected = edit.expected_replacements ?? 1;
            const count = raw.split(edit.old_string).length - 1;
            if (count !== expected)
                throw new Error(`Match count for ${edit.path} was ${count}; expected ${expected}. No files were modified.`);
            const updated = raw.split(edit.old_string).join(edit.new_string);
            plans.push({ path: fileReal, raw, updated, count });
            totalReplacements += count;
        }
        const written = [];
        try {
            for (const plan of plans) {
                writeFileSync(plan.path, plan.updated, "utf8");
                written.push(plan);
            }
        }
        catch (error) {
            for (const plan of written.reverse()) {
                try { writeFileSync(plan.path, plan.raw, "utf8"); } catch {}
            }
            throw error;
        }
        const summaries = plans.map((p) => `${p.path}: ${p.count} replacement(s)`);
        logToolCall(config, { tool: "multi_edit_fast", workspaceId: workspace.id, path: workspace.root, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: summaries.join("\n") }],
            structuredContent: { files_changed: plans.length, replacements: totalReplacements, summaries },
        };
    });
    registerAppTool(registrationTarget, "run_checks_fast", {
        title: "Run project checks (fast)",
        description: "Run a small whitelist of common project checks in one MCP call. Only predefined read/verification commands are allowed.",
        inputSchema: {
            path: z.string().describe("Absolute project directory inside an allowed root."),
            checks: z.array(z.enum(["git_status","git_diff","npm_test","npm_lint","pytest","python_compile"])).min(1).max(6),
        },
        outputSchema: {
            results: z.array(z.object({ check: z.string(), ok: z.boolean(), output: z.string() })),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ path, checks }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace } = await workspaces.openWorkspace({ path, mode: "checkout" }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const commands = {
            git_status: [gitCommand, ["-C", workspace.root, "status", "--short"]],
            git_diff: [gitCommand, ["-C", workspace.root, "diff", "--"]],
            npm_test: [npmCommand, ["test"]],
            npm_lint: [npmCommand, ["run", "lint"]],
            pytest: [pythonCommand, ["-m", "pytest", "-q"]],
            python_compile: [pythonCommand, ["-m", "compileall", "-q", "."]],
        };
        const results = [];
        for (const check of checks) {
            const [exe, args] = commands[check];
            try {
                const output = execFileSync(exe, args, { cwd: workspace.root, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 120000 }).trim();
                results.push({ check, ok: true, output: output.slice(0, 30000) });
            }
            catch (error) {
                const output = [error?.stdout?.toString?.(), error?.stderr?.toString?.()].filter(Boolean).join("\n").trim();
                results.push({ check, ok: false, output: output.slice(0, 30000) || String(error?.message ?? error) });
            }
        }
        logToolCall(config, { tool: "run_checks_fast", workspaceId: workspace.id, path: workspace.root, success: results.every((r) => r.ok), durationMs: Math.round(performance.now() - startedAt) });
        return {
            content: [{ type: "text", text: results.map((r) => `## ${r.check}: ${r.ok ? "PASS" : "FAIL"}\n${r.output}`).join("\n\n") }],
            structuredContent: { results },
        };
    });
    registerAppTool(registrationTarget, "open_workspace", {
        title: "Open workspace",
        description: "Start work in a project directory or isolated worktree when no usable workspace_id exists for it. During continued work, reuse the existing workspace_id instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
        inputSchema: {
            path: z
                .string()
                .describe("Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root."),
            mode: z
                .enum(["checkout", "worktree"])
                .optional()
                .describe("Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work."),
            base_ref: z
                .string()
                .optional()
                .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        },
        outputSchema: {
            workspace_id: z.string(),
            root: z.string(),
            mode: z.enum(["checkout", "worktree"]),
            source_root: z.string().optional(),
            worktree: z
                .object({
                path: z.string(),
                base_ref: z.string(),
                base_sha: z.string(),
                dirty_source: z.boolean(),
                detached: z.boolean(),
                managed: z.boolean(),
            })
                .optional(),
            agents_files: z.array(workspaceAgentsFileOutputSchema).optional(),
            available_agents_files: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
            skills: z.array(workspaceSkillOutputSchema).optional(),
            agent_providers: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
            agents: z.array(workspaceLocalAgentOutputSchema).optional(),
            skill_diagnostics: z.array(z.unknown()).optional(),
            review: z.discriminatedUnion("available", [
                z.object({ available: z.literal(true) }),
                z.object({
                    available: z.literal(false),
                    reason: z.string(),
                }),
            ]),
            instruction: z.string(),
        },
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ path, mode, base_ref }, { _meta }) => {
        const startedAt = performance.now();
        const baseRef = base_ref;
        const { workspace, agentsFiles, availableAgentsFiles, workspaceReused, includeBootstrapContext, } = await workspaces.openWorkspace({ path, mode, baseRef }, { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) });
        const review = await reviewCheckpoints.initializeWorkspace({
            workspaceId: workspace.id,
            root: workspace.root,
        });
        const preloadSubagents = config.subagents.enabled
            && config.subagents.instructions === "preload";
        const subagentsSkill = workspace.skills.find((skill) => skill.name === "subagents");
        const preloadedSubagentInstructions = preloadSubagents && subagentsSkill
            ? readFileSync(subagentsSkill.filePath, "utf8")
            : undefined;
        const cardSkills = workspace.skills
            .filter((skill) => !skill.disableModelInvocation)
            .filter((skill) => !(preloadSubagents && skill.name === "subagents"))
            .map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: formatPathForPrompt(skill.filePath),
        }));
        const agentCatalog = buildLocalAgentCatalog(config.subagents, workspace.agentProfiles, resolveLocalAgentProviders());
        const cardAgentProviders = agentCatalog.providers
            .filter((provider) => provider.usable)
            .map((provider) => ({
            id: provider.id,
            model: provider.model,
            effort: provider.effort,
            note: provider.note,
        }));
        const cardAgents = agentCatalog.profiles;
        const cardAgentsFiles = agentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
            content: file.content,
        }));
        const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
        }));
        const visibleSkills = includeBootstrapContext ? cardSkills : [];
        const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
        const visibleAgents = includeBootstrapContext ? cardAgents : [];
        const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
        const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
        const cardInstruction = config.skillsEnabled
            ? "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
            : "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file.";
        const workspaceInstruction = workspaceReused
            ? [
                `Workspace already open as ${workspace.id}.`,
                "Continue with this workspace_id.",
                "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
            ].join("\n\n")
            : workspace.mode === "worktree"
                ? "Use this workspace_id for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
                : cardInstruction;
        const instruction = preloadedSubagentInstructions && includeBootstrapContext
            ? [
                workspaceInstruction,
                "Subagent workflow instructions:",
                preloadedSubagentInstructions,
            ].join("\n\n")
            : workspaceInstruction;
        const resultContent = [
            {
                type: "text",
                text: [
                    workspaceReused
                        ? `Workspace already open as ${workspace.id}.`
                        : workspace.mode === "worktree"
                            ? `Opened isolated worktree workspace ${workspace.id}.`
                            : `Opened workspace ${workspace.id}.`,
                    `Root: ${workspace.root}`,
                    `Mode: ${workspace.mode}`,
                    loadedAgentsFiles.length > 0
                        ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
                        : undefined,
                    availableAgentsFileOutputs.length > 0
                        ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
                        : undefined,
                    visibleSkills.length > 0
                        ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
                        : undefined,
                    visibleAgentProviders.length > 0
                        ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
                        : undefined,
                    visibleAgents.length > 0
                        ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
                        : undefined,
                    instruction,
                ].filter(Boolean).join("\n"),
            },
        ];
        logToolCall(config, {
            tool: "open_workspace",
            workspaceId: workspace.id,
            path: workspace.root,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            content: resultContent,
            _meta: {
                card: {
                    workspaceId: workspace.id,
                    root: workspace.root,
                    path: workspace.root,
                    mode: workspace.mode,
                    workspaceReused,
                    includeBootstrapContext,
                    sourceRoot: workspace.sourceRoot,
                    worktree: workspace.worktree,
                    agentsFiles: cardAgentsFiles,
                    availableAgentsFiles: cardAvailableAgentsFiles,
                    skills: cardSkills,
                    agentProviders: cardAgentProviders,
                    agents: cardAgents,
                    review,
                    instruction: cardInstruction,
                    summary: {
                        mode: workspace.mode,
                        agentsFiles: cardAgentsFiles.length,
                        availableAgentsFiles: cardAvailableAgentsFiles.length,
                        skills: cardSkills.length,
                        agentProviders: cardAgentProviders.length,
                        agents: cardAgents.length,
                    },
                },
            },
            structuredContent: {
                workspace_id: workspace.id,
                root: workspace.root,
                mode: workspace.mode,
                source_root: workspace.sourceRoot,
                worktree: workspace.worktree
                    ? {
                        path: workspace.worktree.path,
                        base_ref: workspace.worktree.baseRef,
                        base_sha: workspace.worktree.baseSha,
                        dirty_source: workspace.worktree.dirtySource,
                        detached: workspace.worktree.detached,
                        managed: workspace.worktree.managed,
                    }
                    : undefined,
                review,
                ...(includeBootstrapContext
                    ? {
                        agents_files: loadedAgentsFiles,
                        available_agents_files: availableAgentsFileOutputs,
                        skills: visibleSkills,
                        agent_providers: visibleAgentProviders,
                        agents: visibleAgents,
                        skill_diagnostics: workspace.skillDiagnostics,
                    }
                    : {}),
                instruction,
            },
        };
    });
    registrationTarget.registerTool(toolNames.read, {
        title: "Read file",
        description: [
            "Read all or part of a file in a workspace.",
            "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
            config.skillsEnabled
                ? "If available skills were returned and a task matches one, read the returned skill path before proceeding."
                : "",
        ]
            .filter(Boolean)
            .join(" "),
        inputSchema: {
            workspace_id: z
                .string()
                .describe(workspaceIdDescription),
            path: z
                .string()
                .describe(config.skillsEnabled
                ? "File path relative to the workspace root, or a skill path returned by open_workspace."
                : "File path to read, relative to the workspace root."),
            offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line number to start reading from."),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Maximum number of lines to read."),
        },
        outputSchema: resultOutputSchema(),
        annotations: { readOnlyHint: true },
    }, async ({ workspace_id, ...input }) => {
        const startedAt = performance.now();
        const workspaceId = workspace_id;
        const workspace = await workspaces.getWorkspace(workspaceId);
        const readPath = await workspaces.resolveReadPath(workspace, input.path);
        const response = await readFileTool({ ...input, path: readPath.absolutePath }, { cwd: workspace.root });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.read,
                workspaceId,
                path: input.path,
            }, response.content, startedAt);
            return response;
        }
        logToolCall(config, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            ...response,
            structuredContent: {
                result: contentText(response.content),
            },
        };
    });
    toolSurface.register({
        server: registrationTarget,
        config,
        workspaces,
        processSessions,
    });
    registerAppTool(registrationTarget, "show_changes", {
        title: "Show changes",
        description: "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
        inputSchema: {
            workspace_id: z.string().describe(workspaceIdDescription),
        },
        outputSchema: resultOutputSchema({
            workspace_id: z.string(),
            review_ref: z.string().regex(/^[0-9a-f]{40,64}$/),
        }),
        ...workspaceAppDescriptorMeta(config),
        annotations: { readOnlyHint: true },
    }, async ({ workspace_id }, { _meta }) => {
        const startedAt = performance.now();
        const workspaceId = workspace_id;
        const workspace = await workspaces.getWorkspace(workspaceId);
        const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
            ? _meta["devspace/reviewRef"]
            : undefined;
        const review = reviewRef
            ? await reviewCheckpoints.reviewByRef({
                workspaceId,
                root: workspace.root,
                reviewRef,
            })
            : await reviewCheckpoints.reviewChanges({
                workspaceId,
                root: workspace.root,
                markReviewed: true,
            });
        const content = [textBlock(review.result)];
        logToolCall(config, {
            tool: "show_changes",
            workspaceId,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            content,
            _meta: {
                card: {
                    workspaceId,
                    summary: review.summary,
                    files: review.files,
                    payload: {
                        patch: review.patch,
                    },
                },
            },
            structuredContent: {
                workspace_id: workspaceId,
                review_ref: review.reviewRef,
                result: contentText(content),
            },
        };
    });
    if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
        registerArtifactTools(registrationTarget, {
            config,
            workspaces,
            incomingArtifactAdapters,
        });
    }
}
function withTrackedToolHandlers(server, trackToolActivity) {
    return {
        registerTool: ((...args) => {
            const handler = args.at(-1);
            return server.registerTool(...args.slice(0, -1), (...handlerArgs) => trackToolActivity(() => Promise.resolve(handler(...handlerArgs))));
        }),
        registerResource: server.registerResource.bind(server),
    };
}
export function createServer(config = loadConfig(), options = {}) {
    const incomingArtifactAdapters = options.incomingArtifactAdapters
        ?? [createOpenAIIncomingArtifactAdapter()];
    const allowedHosts = config.allowedHosts.includes("*")
        ? undefined
        : Array.from(new Set([config.host, ...config.allowedHosts]));
    const app = createMcpExpressApp({
        host: config.host,
        ...(allowedHosts ? { allowedHosts } : {}),
    });
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    const bearerAuth = requireBearerAuth({
        verifier: oauthProvider,
        requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
    const workspaceStore = createWorkspaceStore(config.stateDir);
    const workspaces = new WorkspaceRegistry(config, workspaceStore);
    const reviewCheckpoints = createReviewCheckpointManager();
    const processSessions = new ProcessSessionManager();
    const toolActivities = new ToolActivityTracker();
    const localAgentProviders = buildLocalAgentProviderStatuses(config.subagents, getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents));
    const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(config.subagents, getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents));
    const modernToolSurface = getToolSurface(config.toolMode);
    const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
        registerMcpSurface(target, config, workspaces, reviewCheckpoints, processSessions, resolveLocalAgentProviders, incomingArtifactAdapters, toolActivities.track);
    });
    const logMcpHandlerError = (error) => logEvent(config.logging, "error", "mcp_handler_error", modernMcpAdapterErrorLogFields(error));
    const mcpHandler = createMcpHandler(() => {
        const adapter = createModernMcpServerAdapter(mcpServerInfo(), { instructions: serverInstructions(config, modernToolSurface) });
        bindModernMcpSurface(adapter.registrationTarget);
        return adapter.server;
    }, {
        legacy: "stateless",
        onerror: logMcpHandlerError,
    });
    const mcpNodeHandler = toNodeHandler(mcpHandler, {
        onerror: logMcpHandlerError,
    });
    if (config.logging.trustProxy) {
        app.set("trust proxy", true);
    }
    app.use((req, res, next) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        res.locals.requestId = requestId;
        res.on("finish", () => {
            const path = requestPath(req);
            if (!config.logging.requests)
                return;
            if (!config.logging.assets && path.startsWith("/mcp-app-assets"))
                return;
            logEvent(config.logging, "info", "http_request", {
                requestId,
                method: req.method,
                path,
                status: res.statusCode,
                durationMs: Math.round(performance.now() - startedAt),
                ...requestLogFields(req, config),
            });
        });
        next();
    });
    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "DevSpace",
    }));
    app.options("/mcp-app-assets/{*asset}", (_req, res) => {
        setAssetHeaders(res);
        res.sendStatus(204);
    });
    app.use("/mcp-app-assets", express.static(uiBuildDirectory(), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
        setHeaders: setAssetHeaders,
    }));
    app.get("/healthz", (_req, res) => {
        res.json({ ok: true, name: "devspace" });
    });
    app.all("/mcp", async (req, res) => {
        const requestId = res.locals.requestId;
        await new Promise((resolve, reject) => {
            bearerAuth(req, res, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
        if (res.headersSent)
            return;
        if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
            logEvent(config.logging, "warn", "auth_denied", {
                requestId,
                method: req.method,
                path: requestPath(req),
                reason: "invalid_oauth_resource",
                ...requestLogFields(req, config),
            });
            sendJsonRpcError(res, 401, -32001, "Unauthorized");
            return;
        }
        logEvent(config.logging, "info", "mcp_request", {
            requestId,
            method: req.method,
            rpcMethod: req.body?.method,
            rpcId: req.body?.id,
        });
        try {
            await mcpNodeHandler(req, res, req.body);
        }
        catch (error) {
            logEvent(config.logging, "error", "mcp_request_error", {
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
                sendJsonRpcError(res, 500, -32603, "Internal server error");
            }
        }
    });
    let closePromise;
    return {
        app,
        config,
        localAgentProviders,
        close: () => {
            closePromise ??= (async () => {
                try {
                    await mcpHandler.close();
                }
                catch (error) {
                    logEvent(config.logging, "warn", "mcp_handler_close_failed", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                await toolActivities.waitForIdle();
                processSessions.shutdown();
                oauthProvider.close();
                workspaceStore.close?.();
            })();
            return closePromise;
        },
    };
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const entrypointPath = await realpath(process.argv[1]);
    return modulePath === entrypointPath;
}
if (await isMainModule()) {
    const { app, config, close, localAgentProviders } = createServer();
    const httpServer = app.listen(config.port, config.host, () => {
        console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
        console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
        console.log("auth: oauth owner-token flow required");
        console.log(`logging: ${config.logging.level} ${config.logging.format}`);
        console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
        console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
        console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
        const artifactDownloadStatus = !config.artifactsEnabled
            ? "disabled"
            : isArtifactDownloadSupportedPlatform()
                ? "enabled"
                : `unsupported on ${process.platform}`;
        console.log(`native artifact download: ${artifactDownloadStatus}`);
        console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
    });
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        await shutdownHttpServer(httpServer, close);
        process.exit(0);
    };
    const handleShutdown = () => {
        void shutdown().catch((error) => {
            console.error("devspace shutdown failed", error);
            process.exit(1);
        });
    };
    process.once("SIGINT", handleShutdown);
    process.once("SIGTERM", handleShutdown);
}
