/** `hoja_artifact_upload` (HOJA-841): pi's way to put a file in Hoja, matching the Claude Code plugin's
 *  `hoja_artifactUpload`. Uses the same credentials as `hoja_decision_ask` (HOJA_API_URL / HOJA_TOKEN). */
import { resolveHojaToken, resolveHojaUrl } from "../../.pi/lib/claw/hoja.ts";
import { artifactClient, cwdOf, uploadMany, type HttpFetch } from "./artifacts.ts";

export const HOJA_ARTIFACT_UPLOAD_CONTRACT = {
	description:
		"Upload local files (screenshots, screen recordings, PDFs, rendered design options) to Hoja and optionally attach them to a task. "
		+ "Returns each file's shareable url/absoluteUrl and Markdown to paste into comments, descriptions or decisions. "
		+ "Never put a local path in Hoja (/tmp/..., /root/..., /home/..., relative repo paths like app/artifacts/x.html, file://, http://localhost): "
		+ "it only opens on this machine and the person cannot see it. "
		+ "For N visual options: render each to PNG/JPG/WebP (or MP4 for motion), upload them all here, then pass each URL as an option's mediaUrl in hoja_decision_ask. "
		+ "Hoja refuses SVG and HTML uploads (they could execute as documents): render SVG/HTML to PNG first (one contact-sheet PNG is fine too).",
	parameters: {
		type: "object",
		required: ["paths"],
		additionalProperties: false,
		properties: {
			paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "Local file paths to upload (absolute, or relative to the working directory)." },
			issue: { type: "string", description: "Hoja task identifier (e.g. HOJA-123) to attach each file to." },
			titles: { type: "array", items: { type: "string" }, description: "Optional titles, same order as paths (default: the file name)." },
			ttlDays: { type: "integer", minimum: 1, maximum: 365, description: "Delete the files after this many days." },
		},
	},
};

type UploadParams = { paths: string[]; issue?: string; titles?: string[]; ttlDays?: number };

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], details: {}, ...(isError ? { isError: true } : {}) });

export interface HojaArtifactsOptions { fetch?: HttpFetch; env?: NodeJS.ProcessEnv }

export function registerHojaArtifacts(pi: any, options: HojaArtifactsOptions = {}): void {
	const env = options.env ?? process.env;
	const url = resolveHojaUrl(env);
	const token = resolveHojaToken(env);
	pi.registerTool({
		name: "hoja_artifact_upload",
		label: "Hoja upload",
		...HOJA_ARTIFACT_UPLOAD_CONTRACT,
		async execute(_id: string, params: UploadParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			if (!url || !token) return text({ error: "Hoja is not configured: set HOJA_TOKEN and HOJA_API_URL." }, true);
			if (!Array.isArray(params?.paths) || !params.paths.length) return text({ error: "hoja_artifact_upload: pass paths: [\"/path/to/file.png\"]" }, true);
			const client = artifactClient({ url, token, fetch: options.fetch, cwd: cwdOf(ctx) });
			const { uploaded, errors } = await uploadMany(client, params);
			return text({ uploaded, ...(errors.length ? { errors } : {}) }, uploaded.length === 0);
		},
	});
}

export default function hojaArtifacts(pi: any): void {
	registerHojaArtifacts(pi);
}
