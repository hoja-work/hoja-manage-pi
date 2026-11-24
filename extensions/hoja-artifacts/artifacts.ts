/** Artifacts a pi agent produces (screenshots, recordings, PDFs, rendered design options) become real Hoja uploads,
 *  never local paths (HOJA-841, ported from hoja-claude-plugin `src/artifacts.ts`, HOJA-798). A path on the runner box
 *  (`/tmp/x.png`, `app/artifacts/options/index.html`, `file://…`, `http://localhost…`) only ever opens there.
 *
 *  - `uploadFile`: begin (`POST {origin}/api/uploads/direct`) → PUT the bytes to storage → complete (attach to a task).
 *  - `rewriteLocalMedia`: upload every existing local media file a text mentions and swap the path for its URL.
 *  - `localReferences`: what is still local after the rewrite (SVG/HTML, file://, localhost, absolute artifact paths),
 *    so a caller can refuse instead of publishing a dead link. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";

type Json = Record<string, any>;
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: any; signal?: AbortSignal; redirect?: "error" }) =>
	Promise<{ status: number; text(): Promise<string> }>;

export const MEDIA_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "pdf"];
/** Hoja refuses these: a browser could execute them as a document (Hoja-Cloud app/hoja_server/uploads.py). */
export const REFUSED_EXTENSIONS = ["svg", "html", "htm", "xhtml", "js", "mjs"];
/** Extensions that mark an absolute path as an artifact a person was meant to open (not source code being cited). */
const ARTIFACT_EXTENSIONS = [...MEDIA_EXTENSIONS, "svg", "html", "htm", "xhtml", "zip", "gz", "tgz", "txt", "log", "csv", "json", "md"];

const MEDIA_RE = new RegExp(
	String.raw`(?<![\w/:.~-])(?:file://)?(?:~/|/|\./|\.\./)?(?:[\w@%+=,.-]+/)*[\w@%+=,.-]+\.(?:${MEDIA_EXTENSIONS.join("|")})(?![\w/])`,
	"gi",
);
const LOCAL_RES: RegExp[] = [
	/file:\/\/[^\s)\]"'`<>]+/gi,
	/https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s)\]"'`<>]*)?/gi,
	// Relative or absolute SVG/HTML paths: Hoja cannot host them, so they are always a dead link.
	new RegExp(String.raw`(?<![\w/:.~-])(?:~/|/|\./|\.\./)?(?:[\w@%+=,.-]+/)*[\w@%+=,.-]+\.(?:svg|html?|xhtml)(?![\w/])`, "gi"),
	// Absolute paths on this box to an artifact.
	new RegExp(String.raw`(?<![\w/:.~-])(?:~|/root|/tmp|/home|/var/tmp|/Users)/(?:[\w@%+=,.-]+/)*[\w@%+=,.-]+\.(?:${ARTIFACT_EXTENSIONS.join("|")})(?![\w/])`, "gi"),
];

export interface Uploaded { path: string; url: string; absoluteUrl: string; contentType: string; size: number; title: string; markdown: string; attachmentId?: string }

export interface ArtifactClient {
	/** The deployment origin, e.g. https://acme.hoja.work */
	origin: string;
	/** Fetch for Hoja's own routes (adds the Bearer token). */
	hojaFetch: HttpFetch;
	/** Unauthenticated fetch for the presigned storage PUT. */
	plainFetch: HttpFetch;
	cwd?: string;
}

/** Build a client from the same credentials `hoja_decision_ask` uses (HOJA_API_URL / HOJA_TOKEN). */
export function artifactClient(options: { url: string; token: string; fetch?: HttpFetch; cwd?: string }): ArtifactClient {
	const parsed = new URL(options.url);
	parsed.pathname = parsed.pathname.replace(/\/graphql\/?$/, "") || "/";
	parsed.search = "";
	parsed.hash = "";
	const origin = parsed.toString().replace(/\/$/, "");
	const fetchImpl: HttpFetch = options.fetch ?? (globalThis.fetch as unknown as HttpFetch);
	const token = options.token.trim();
	const authorization = /^bearer /i.test(token) ? token : `Bearer ${token}`;
	return {
		origin,
		cwd: options.cwd,
		hojaFetch: (url, init) => fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: authorization, "User-Agent": "hoja-manage-pi/artifacts" }, redirect: "error" }),
		plainFetch: (url, init) => fetchImpl(url, init),
	};
}

/** The session's working directory: relative paths an agent names resolve against it. */
export const cwdOf = (ctx: any): string => String(ctx?.sessionManager?.getCwd?.() ?? ctx?.cwd ?? process.cwd());

export function resolveLocalPath(raw: string, cwd = process.cwd()): string {
	let p = raw.startsWith("file://") ? decodeURIComponent(raw.slice("file://".length)) : raw;
	if (p.startsWith("~/")) p = homedir() + p.slice(1);
	return isAbsolute(p) ? p : resolve(cwd, p);
}

async function json(res: { status: number; text(): Promise<string> }, what: string): Promise<Json> {
	const text = await res.text();
	let body: Json = {};
	try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
	if (res.status >= 400) throw new Error(`${what} failed (HTTP ${res.status}): ${body.error ?? body.message ?? text.slice(0, 200)}`);
	return body;
}

/** Upload one local file through begin → PUT → complete. */
export async function uploadFile(client: ArtifactClient, rawPath: string, opts: { issue?: string; title?: string; ttlDays?: number } = {}): Promise<Uploaded> {
	const path = resolveLocalPath(rawPath, client.cwd);
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${rawPath}: no such file`);
	const ext = extname(path).slice(1).toLowerCase();
	if (REFUSED_EXTENSIONS.includes(ext)) {
		throw new Error(`${rawPath}: Hoja refuses .${ext} uploads (they could execute as a document). Render it to PNG (a contact-sheet PNG is fine) and upload that.`);
	}
	const bytes = readFileSync(path);
	const filename = basename(path);
	const begin = await json(await client.hojaFetch(`${client.origin}/api/uploads/direct`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename, size: bytes.length, ...(opts.ttlDays ? { ttlDays: opts.ttlDays } : {}) }),
	}), `upload ${filename}`);
	const put = begin.put ?? {};
	if (!put.url) throw new Error(`upload ${filename}: the server returned no storage URL`);
	const sender = put.auth ? client.hojaFetch : client.plainFetch;
	const sent = await sender(put.url, { method: put.method ?? "PUT", headers: { ...(put.headers ?? {}) }, body: bytes });
	if (sent.status >= 300) throw new Error(`upload ${filename}: storage refused the bytes (HTTP ${sent.status})`);
	const title = opts.title?.trim() || filename;
	const done = await json(await client.hojaFetch(begin.completeUrl ?? `${client.origin}/api/uploads/${begin.id}/complete`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify(opts.issue ? { issueId: opts.issue, title } : {}),
	}), `complete ${filename}`);
	const url = String(done.url ?? begin.url ?? "");
	const absoluteUrl = done.absoluteUrl ?? `${client.origin}${url}`;
	const contentType = String(done.contentType ?? begin.contentType ?? "");
	const markdown = contentType.startsWith("image/") ? `![${title}](${absoluteUrl})` : `[${title}](${absoluteUrl})`;
	return { path, url, absoluteUrl, contentType, size: Number(done.size ?? bytes.length), title, markdown, ...(done.attachment?.id ? { attachmentId: done.attachment.id } : {}) };
}

/** Upload `paths` (optionally attaching each to `issue`); one failure never stops the rest. */
export async function uploadMany(client: ArtifactClient, args: { paths?: unknown; issue?: string; titles?: unknown; ttlDays?: number }): Promise<{ uploaded: Json[]; errors: string[] }> {
	const paths = Array.isArray(args.paths) ? args.paths.map(String).filter((p) => p.trim()) : [];
	const titles = Array.isArray(args.titles) ? args.titles.map(String) : [];
	const uploaded: Json[] = [];
	const errors: string[] = [];
	for (const [i, p] of paths.entries()) {
		try {
			const up = await uploadFile(client, p, { issue: args.issue?.trim() || undefined, title: titles[i], ttlDays: args.ttlDays });
			uploaded.push({ path: p, url: up.url, absoluteUrl: up.absoluteUrl, contentType: up.contentType, size: up.size, markdown: up.markdown, ...(up.attachmentId ? { attachmentId: up.attachmentId } : {}) });
		} catch (error) { errors.push((error as Error).message); }
	}
	return { uploaded, errors };
}

/**
 * Replace local media paths in every string of `args` with Hoja URLs, uploading each existing file once.
 * Paths that do not exist are left alone (they may be code or prose), so this never invents a link.
 */
export async function rewriteLocalMedia<T>(client: ArtifactClient, args: T, issue?: string): Promise<{ args: T; uploaded: Uploaded[]; errors: string[] }> {
	const cache = new Map<string, Uploaded | null>();
	const uploaded: Uploaded[] = [];
	const errors: string[] = [];
	const rewrite = async (text: string): Promise<string> => {
		const matches = [...text.matchAll(MEDIA_RE)].map((m) => m[0]);
		if (!matches.length) return text;
		let out = text;
		for (const raw of new Set(matches)) {
			const path = resolveLocalPath(raw, client.cwd);
			if (!cache.has(path)) {
				let up: Uploaded | null = null;
				if (existsSync(path) && statSync(path).isFile()) {
					try { up = await uploadFile(client, raw, { issue }); uploaded.push(up); }
					catch (error) { errors.push((error as Error).message); }
				}
				cache.set(path, up);
			}
			const up = cache.get(path);
			if (!up) continue;
			// A field that is only a path (mediaUrl) becomes only the URL.
			if (text.trim() === raw) return up.absoluteUrl;
			// Inside Markdown link/image syntax the URL replaces the target; bare prose gets Markdown.
			out = out.split(`](${raw})`).join(`](${up.absoluteUrl})`);
			out = out.replace(new RegExp(`(?<![\\w/:.~(-])${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`, "g"), up.markdown);
		}
		return out;
	};
	const walk = async (value: any): Promise<any> => {
		if (typeof value === "string") return rewrite(value);
		if (Array.isArray(value)) return Promise.all(value.map(walk));
		if (value && typeof value === "object") {
			const out: Json = {};
			for (const [k, v] of Object.entries(value)) out[k] = await walk(v);
			return out;
		}
		return value;
	};
	return { args: await walk(args), uploaded, errors };
}

/** Local references left in any string of `value` that a person in Hoja could never open. */
export function localReferences(value: unknown): string[] {
	const found = new Set<string>();
	const visit = (v: unknown) => {
		if (typeof v === "string") {
			for (const re of LOCAL_RES) for (const m of v.matchAll(re)) found.add(m[0].replace(/[.,;:!?]+$/, ""));
		} else if (Array.isArray(v)) v.forEach(visit);
		else if (v && typeof v === "object") Object.values(v).forEach(visit);
	};
	visit(value);
	return [...found];
}
