/**
 * Modrinth MCP connector - a Cloudflare Worker.
 *
 * Connect Claude to:   https://<your-worker>.workers.dev/mcp
 * and send your Modrinth personal access token as an API key header:
 *     Authorization: Bearer mrp_...      (or  x-api-key: mrp_...)
 *
 * Fallback for clients that can't set headers: https://<your-worker>.workers.dev/<token>/mcp
 *
 * The token is read on every request and only ever sent to api.modrinth.com.
 * It is never stored or logged.
 */
import { unzipSync, strFromU8 } from "fflate";

const API = "https://api.modrinth.com/v2";
const UA = "modrinth-mcp-worker/1.0 (+https://github.com/p1e2r)";
const FABRIC_API = "P7dR8mSH";
const SERVER_INFO = { name: "modrinth", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ------------------------------------------------------------------ HTTP entry

export default {
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const parts = url.pathname.split("/").filter(Boolean);

		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

		if (parts.length === 0) {
			return text("Modrinth MCP connector. Connect to https://<this-host>/mcp with header 'Authorization: Bearer <your-modrinth-token>'.", 200);
		}

		let token: string | undefined;
		if (parts.length === 1 && parts[0] === "mcp") {
			// main way: token in a header
			token = tokenFromHeaders(req.headers);
			if (!token) {
				return text("Missing Modrinth token. Send it as 'Authorization: Bearer mrp_...' or 'x-api-key: mrp_...'.", 401);
			}
		} else if (parts.length === 2 && parts[1] === "mcp" && decodeURIComponent(parts[0]).startsWith("mrp_")) {
			// fallback: /<token>/mcp for clients that can't set headers
			token = decodeURIComponent(parts[0]);
		} else {
			return text("Not found. Use /mcp with an Authorization header.", 404);
		}
		if (!token.startsWith("mrp_")) {
			return text("That doesn't look like a Modrinth personal access token (they start with mrp_).", 401);
		}

		if (req.method === "GET") return text("This endpoint speaks MCP over POST.", 405, { Allow: "POST" });
		if (req.method === "DELETE") return new Response(null, { status: 204, headers: cors() });
		if (req.method !== "POST") return text("Method not allowed", 405, { Allow: "POST" });

		let msg: any;
		try {
			msg = await req.json();
		} catch {
			return json(rpcError(null, -32700, "Parse error"), 400);
		}

		const ctx = new Modrinth(token);
		if (Array.isArray(msg)) {
			const out = (await Promise.all(msg.map((m) => handle(m, ctx)))).filter((r) => r !== null);
			return out.length ? json(out) : new Response(null, { status: 202, headers: cors() });
		}
		const res = await handle(msg, ctx);
		return res === null ? new Response(null, { status: 202, headers: cors() }) : json(res);
	},
};

function tokenFromHeaders(h: Headers): string | undefined {
	const auth = h.get("authorization")?.trim();
	if (auth) return auth.replace(/^Bearer\s+/i, "").trim() || undefined;
	return (h.get("x-api-key") ?? h.get("x-auth-token"))?.trim() || undefined;
}

function cors(extra: Record<string, string> = {}) {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Authorization, X-Api-Key, X-Auth-Token",
		"Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
		...extra,
	};
}
function text(body: string, status: number, headers: Record<string, string> = {}) {
	return new Response(body, { status, headers: cors({ "Content-Type": "text/plain; charset=utf-8", ...headers }) });
}
function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: cors({ "Content-Type": "application/json" }) });
}

// ------------------------------------------------------------------ JSON-RPC / MCP

function rpcError(id: unknown, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handle(m: any, ctx: Modrinth): Promise<any> {
	if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
		return rpcError(m?.id ?? null, -32600, "Invalid request");
	}
	const isNotification = m.id === undefined || m.id === null;
	if (isNotification) return null; // notifications/initialized, cancelled, ...

	switch (m.method) {
		case "initialize": {
			const asked = m.params?.protocolVersion;
			return {
				jsonrpc: "2.0",
				id: m.id,
				result: {
					protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: SERVER_INFO,
					instructions:
						"Tools for the Modrinth projects of the account whose token is in the connector URL. " +
						"Projects can be given as a slug (e.g. tnt-ring) or id. Use upload_version with dry_run first to show the user what will be uploaded.",
				},
			};
		}
		case "ping":
			return { jsonrpc: "2.0", id: m.id, result: {} };
		case "tools/list":
			return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS.map(({ run, ...t }) => t) } };
		case "tools/call": {
			const tool = TOOLS.find((t) => t.name === m.params?.name);
			if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${m.params?.name}`);
			try {
				const out = await tool.run(m.params?.arguments ?? {}, ctx);
				return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out } };
			} catch (e: any) {
				return { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] } };
			}
		}
		default:
			return rpcError(m.id, -32601, `Method not found: ${m.method}`);
	}
}

// ------------------------------------------------------------------ Modrinth client

class Modrinth {
	constructor(private token: string) {}

	async req(path: string, init: RequestInit = {}): Promise<any> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", this.token);
		headers.set("User-Agent", UA);
		const r = await fetch(API + path, { ...init, headers });
		if (r.status === 204) return null;
		const body = await r.text();
		let data: any = body;
		try { data = body ? JSON.parse(body) : null; } catch { /* plain text */ }
		if (!r.ok) {
			const why = data?.description || data?.error || body || r.statusText;
			if (r.status === 401) throw new Error(`Modrinth rejected the token (${why}). Check it hasn't expired and has the needed scopes.`);
			throw new Error(`Modrinth API ${r.status} on ${path}: ${why}`);
		}
		return data;
	}

	project(idOrSlug: string) { return this.req(`/project/${encodeURIComponent(idOrSlug)}`); }
	versions(idOrSlug: string) { return this.req(`/project/${encodeURIComponent(idOrSlug)}/version`); }
	patchProject(id: string, body: object) {
		return this.req(`/project/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	}
}

// ------------------------------------------------------------------ jar detection

type Detected = { loaders: string[]; modVersion?: string; mcHint?: string; needsFabricApi: boolean; kind: string };

function detectJar(bytes: Uint8Array): Detected {
	const wanted = new Set(["fabric.mod.json", "quilt.mod.json", "META-INF/neoforge.mods.toml", "META-INF/mods.toml", "plugin.yml", "paper-plugin.yml"]);
	const files = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
	const read = (n: string) => (files[n] ? strFromU8(files[n]) : undefined);

	const fabric = read("fabric.mod.json");
	if (fabric) {
		const j = JSON.parse(fabric);
		const deps = { ...(j.depends ?? {}) };
		const mc = Array.isArray(deps.minecraft) ? deps.minecraft[0] : deps.minecraft;
		return { kind: "fabric", loaders: ["fabric", "quilt"], modVersion: j.version, mcHint: mc, needsFabricApi: "fabric-api" in deps || "fabric" in deps };
	}
	const quilt = read("quilt.mod.json");
	if (quilt) {
		const j = JSON.parse(quilt);
		const dep = (j.quilt_loader?.depends ?? []).find((d: any) => d?.id === "minecraft");
		return { kind: "quilt", loaders: ["quilt"], modVersion: j.quilt_loader?.version, mcHint: typeof dep?.versions === "string" ? dep.versions : dep?.versions?.[0], needsFabricApi: false };
	}
	for (const [file, loader] of [["META-INF/neoforge.mods.toml", "neoforge"], ["META-INF/mods.toml", "forge"]] as const) {
		const t = read(file);
		if (!t) continue;
		const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(t)?.[1];
		const mcBlock = t.split(/\[\[dependencies\.[^\]]+\]\]/).find((b) => /modId\s*=\s*"minecraft"/.test(b));
		const range = mcBlock ? /versionRange\s*=\s*"([^"]+)"/.exec(mcBlock)?.[1] : undefined;
		return { kind: loader, loaders: [loader], modVersion: version, mcHint: range, needsFabricApi: false };
	}
	const plugin = read("paper-plugin.yml") ?? read("plugin.yml");
	if (plugin) {
		const version = /^version:\s*['"]?([^'"\n]+)/m.exec(plugin)?.[1]?.trim();
		const api = /^api-version:\s*['"]?([^'"\n]+)/m.exec(plugin)?.[1]?.trim();
		const folia = /^folia-supported:\s*true/m.test(plugin);
		return { kind: "paper", loaders: folia ? ["paper", "purpur", "folia"] : ["paper", "purpur"], modVersion: version, mcHint: api, needsFabricApi: false };
	}
	throw new Error("Couldn't tell what loader this jar is for (no fabric.mod.json, quilt.mod.json, mods.toml, neoforge.mods.toml or plugin.yml). Pass loaders yourself.");
}

/** "~26.2", ">=26.2", "[26.2,26.3)", "26.2.x", "26.2" -> "26.2" (checked against Modrinth's list). */
function resolveMc(hint: string | undefined, known: string[]): string | undefined {
	if (!hint) return undefined;
	const m = /(\d+\.\d+(?:\.\d+)?)/.exec(hint);
	if (!m) return undefined;
	let v = m[1];
	if (known.includes(v)) return v;
	v = v.split(".").slice(0, 2).join(".");
	return known.includes(v) ? v : undefined;
}

async function sha1(bytes: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest("SHA-1", bytes);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(s: string): Uint8Array {
	const bin = atob(s.replace(/^data:[^,]+,/, "").replace(/\s+/g, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// ------------------------------------------------------------------ tools

type Tool = { name: string; title: string; description: string; inputSchema: any; annotations?: any; run: (a: any, c: Modrinth) => Promise<any> };

const projectArg = { type: "string", description: "Project slug (e.g. tnt-ring) or id" };

const TOOLS: Tool[] = [
	{
		name: "get_project",
		title: "Get project",
		description: "Get a Modrinth project's details: title, summary, status (e.g. processing = under review), loaders, game versions, links and counts.",
		inputSchema: { type: "object", properties: { project: projectArg }, required: ["project"] },
		annotations: { readOnlyHint: true },
		async run({ project }, c) {
			const p = await c.project(project);
			return {
				id: p.id, slug: p.slug, title: p.title, summary: p.description, status: p.status, project_type: p.project_type,
				url: `https://modrinth.com/${p.project_type}/${p.slug}`,
				license: p.license?.id, client_side: p.client_side, server_side: p.server_side,
				categories: p.categories, loaders: p.loaders, game_versions: p.game_versions,
				downloads: p.downloads, followers: p.followers, version_count: p.versions?.length ?? 0,
				links: { issues: p.issues_url, source: p.source_url, wiki: p.wiki_url, discord: p.discord_url },
				icon_url: p.icon_url, published: p.published, updated: p.updated,
			};
		},
	},
	{
		name: "get_stats",
		title: "Get stats",
		description: "Downloads and followers for a project, with downloads broken down per version (most downloaded first).",
		inputSchema: { type: "object", properties: { project: projectArg }, required: ["project"] },
		annotations: { readOnlyHint: true },
		async run({ project }, c) {
			const [p, vs] = await Promise.all([c.project(project), c.versions(project)]);
			const per = vs.map((v: any) => ({ version_number: v.version_number, loaders: v.loaders, game_versions: v.game_versions, downloads: v.downloads }))
				.sort((a: any, b: any) => b.downloads - a.downloads);
			return { title: p.title, status: p.status, downloads: p.downloads, followers: p.followers, versions: per };
		},
	},
	{
		name: "list_versions",
		title: "List versions",
		description: "List all versions of a project with loaders, game versions, files and dependencies.",
		inputSchema: { type: "object", properties: { project: projectArg }, required: ["project"] },
		annotations: { readOnlyHint: true },
		async run({ project }, c) {
			const vs = await c.versions(project);
			return {
				count: vs.length,
				versions: vs.map((v: any) => ({
					id: v.id, name: v.name, version_number: v.version_number, version_type: v.version_type, status: v.status,
					loaders: v.loaders, game_versions: v.game_versions, downloads: v.downloads, date_published: v.date_published,
					files: v.files.map((f: any) => ({ filename: f.filename, size: f.size, sha1: f.hashes?.sha1, url: f.url })),
					dependencies: v.dependencies,
				})),
			};
		},
	},
	{
		name: "update_links",
		title: "Update links",
		description: "Set a project's issue tracker, source code, wiki and/or Discord links. Only the links you pass are changed; pass an empty string to remove one.",
		inputSchema: {
			type: "object",
			properties: {
				project: projectArg,
				issues_url: { type: "string", description: "Issue tracker URL, e.g. https://github.com/you/repo/issues" },
				source_url: { type: "string", description: "Source code URL" },
				wiki_url: { type: "string", description: "Wiki URL" },
				discord_url: { type: "string", description: "Discord invite URL" },
			},
			required: ["project"],
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async run(a, c) {
			const p = await c.project(a.project);
			const patch: Record<string, string | null> = {};
			for (const k of ["issues_url", "source_url", "wiki_url", "discord_url"]) {
				if (typeof a[k] === "string") patch[k] = a[k] === "" ? null : a[k];
			}
			if (!Object.keys(patch).length) throw new Error("Pass at least one of issues_url, source_url, wiki_url, discord_url.");
			await c.patchProject(p.id, patch);
			const after = await c.project(p.id);
			return { updated: Object.keys(patch), links: { issues: after.issues_url, source: after.source_url, wiki: after.wiki_url, discord: after.discord_url } };
		},
	},
	{
		name: "update_description",
		title: "Update description",
		description: "Replace a project's long description (markdown body) and/or its one-line summary.",
		inputSchema: {
			type: "object",
			properties: {
				project: projectArg,
				body: { type: "string", description: "Full markdown description (replaces the current one)" },
				summary: { type: "string", description: "Short one-line summary shown in search results" },
			},
			required: ["project"],
		},
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		async run(a, c) {
			const p = await c.project(a.project);
			const patch: Record<string, string> = {};
			if (typeof a.body === "string") patch.body = a.body;
			if (typeof a.summary === "string") patch.description = a.summary;
			if (!Object.keys(patch).length) throw new Error("Pass body and/or summary.");
			await c.patchProject(p.id, patch);
			return { updated: Object.keys(patch).map((k) => (k === "description" ? "summary" : k)), url: `https://modrinth.com/${p.project_type}/${p.slug}` };
		},
	},
	{
		name: "upload_version",
		title: "Upload version",
		description:
			"Upload a mod/plugin jar as a new version. Loader (Fabric+Quilt, Forge, NeoForge, Paper+Purpur), mod version and Minecraft version are read from the jar " +
			"unless you pass them. Fabric jars that need Fabric API get it as a required dependency. Skips files already on the project. " +
			"Give the jar as file_url (a direct download link) or file_base64. Use dry_run: true first to preview.",
		inputSchema: {
			type: "object",
			properties: {
				project: projectArg,
				file_url: { type: "string", description: "Direct download URL of the jar (e.g. a GitHub release asset)" },
				file_base64: { type: "string", description: "The jar's bytes as base64 (alternative to file_url)" },
				filename: { type: "string", description: "File name to show on Modrinth (default: from the URL)" },
				version_number: { type: "string", description: "Default: <mod version>+<mc>-<loader>, e.g. 1.2.0+26.3-neoforge" },
				name: { type: "string", description: "Display name. Default: '<Project> <mod version> (<Loader> <mc>)'" },
				loaders: { type: "array", items: { type: "string" }, description: "Override detected loaders" },
				game_versions: { type: "array", items: { type: "string" }, description: "Override detected Minecraft versions, e.g. ['26.2']" },
				version_type: { type: "string", enum: ["release", "beta", "alpha"], description: "Default: release" },
				changelog: { type: "string", description: "Markdown changelog" },
				dependencies: {
					type: "array",
					description: "Extra dependencies, e.g. [{project_id:'P7dR8mSH', dependency_type:'required'}]",
					items: { type: "object", properties: { project_id: { type: "string" }, version_id: { type: "string" }, dependency_type: { type: "string", enum: ["required", "optional", "incompatible", "embedded"] } }, required: ["dependency_type"] },
				},
				featured: { type: "boolean", description: "Default: false" },
				dry_run: { type: "boolean", description: "Only show what would be uploaded" },
			},
			required: ["project"],
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		async run(a, c) {
			let bytes: Uint8Array;
			let filename: string | undefined = a.filename;
			if (a.file_url) {
				const r = await fetch(a.file_url, { headers: { "User-Agent": UA } });
				if (!r.ok) throw new Error(`Couldn't download ${a.file_url}: HTTP ${r.status}`);
				bytes = new Uint8Array(await r.arrayBuffer());
				filename ??= decodeURIComponent(new URL(r.url || a.file_url).pathname.split("/").pop() || "mod.jar");
			} else if (a.file_base64) {
				bytes = b64ToBytes(a.file_base64);
				filename ??= "mod.jar";
			} else {
				throw new Error("Pass file_url or file_base64.");
			}
			if (bytes.length > 500 * 1024 * 1024) throw new Error("File is larger than Modrinth's 500 MB limit.");

			const [p, existing, gv] = await Promise.all([
				c.project(a.project),
				c.versions(a.project),
				fetch(`${API}/tag/game_version`, { headers: { "User-Agent": UA } }).then((r) => r.json() as Promise<any[]>),
			]);
			const known = gv.map((g) => g.version);

			const det = detectJar(bytes);
			const loaders: string[] = a.loaders?.length ? a.loaders : det.loaders;
			let games: string[] = a.game_versions?.length ? a.game_versions : [];
			if (!games.length) {
				const mc = resolveMc(det.mcHint, known);
				if (!mc) throw new Error(`Couldn't work out the Minecraft version from the jar (found "${det.mcHint ?? "nothing"}"). Pass game_versions.`);
				games = [mc];
			}
			const bad = games.filter((g) => !known.includes(g));
			if (bad.length) throw new Error(`Modrinth doesn't know these Minecraft versions: ${bad.join(", ")}`);

			const modVersion = det.modVersion ?? "1.0.0";
			const loaderTag = det.kind;
			const versionNumber: string = a.version_number ?? `${modVersion}+${games[0]}-${loaderTag}`;
			const pretty: Record<string, string> = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge", paper: "Paper" };
			const name: string = a.name ?? `${p.title} ${modVersion} (${pretty[loaderTag] ?? loaderTag} ${games.join(", ")})`;

			const deps: any[] = [...(a.dependencies ?? [])];
			if (det.needsFabricApi && !deps.some((d) => d.project_id === FABRIC_API)) deps.push({ project_id: FABRIC_API, dependency_type: "required" });

			const hash = await sha1(bytes);
			const dupe = existing.find((v: any) =>
				v.files.some((f: any) => f.hashes?.sha1 === hash) ||
				v.version_number === versionNumber);
			const plan = {
				project: { id: p.id, slug: p.slug, title: p.title, status: p.status },
				filename, size: bytes.length, sha1: hash,
				name, version_number: versionNumber, version_type: a.version_type ?? "release",
				loaders, game_versions: games, dependencies: deps,
			};
			if (dupe) return { skipped: true, reason: `Already on the project as ${dupe.version_number}`, existing_version_url: `https://modrinth.com/${p.project_type}/${p.slug}/version/${dupe.version_number}`, plan };
			if (a.dry_run) return { dry_run: true, plan };

			const data = {
				project_id: p.id, name, version_number: versionNumber, changelog: a.changelog ?? "",
				dependencies: deps, game_versions: games, version_type: a.version_type ?? "release",
				loaders, featured: a.featured ?? false, status: "listed", file_parts: ["file"], primary_file: "file",
			};
			const form = new FormData();
			form.append("data", JSON.stringify(data));
			form.append("file", new File([bytes], filename!, { type: "application/java-archive" }));
			const v = await c.req("/version", { method: "POST", body: form });
			return { uploaded: true, id: v.id, url: `https://modrinth.com/${p.project_type}/${p.slug}/version/${v.version_number}`, plan };
		},
	},
];
