import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactClient, localReferences, rewriteLocalMedia, uploadFile, type HttpFetch } from "../../../extensions/hoja-artifacts/artifacts.ts";
import { HOJA_ARTIFACT_UPLOAD_CONTRACT, registerHojaArtifacts } from "../../../extensions/hoja-artifacts/extension.ts";
import { DecisionApi, type FetchLike } from "../../../extensions/hoja-decision/delivery.ts";
import { HOJA_DECISION_ASK_CONTRACT, MAX_OPTIONS, registerHojaDecision } from "../../../extensions/hoja-decision/extension.ts";

const env = { HOJA_TOKEN: "tok", HOJA_API_URL: "https://acme.hoja.work/graphql" } as NodeJS.ProcessEnv;

/** A Hoja deployment with object storage: begin → presigned PUT → complete, behind one fetch. */
function fakeDeployment(options: { putAuth?: boolean } = {}) {
	const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
	const stored = new Map<string, Buffer>();
	const extOf = new Map<string, string>();
	let n = 0;
	const fetch: HttpFetch = async (url, init) => {
		calls.push({ url, method: init.method, headers: init.headers, body: init.body });
		const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
		if (url === "https://acme.hoja.work/api/uploads/direct") {
			const body = JSON.parse(init.body);
			const id = `blob${++n}`;
			const ext = body.filename.split(".").pop();
			extOf.set(id, ext);
			const ctype = ext === "png" ? "image/png" : ext === "mp4" ? "video/mp4" : "application/pdf";
			return reply(201, {
				id, url: `/api/uploads/${id}.${ext}`, contentType: ctype, size: body.size,
				put: options.putAuth
					? { url: `https://acme.hoja.work/api/uploads/${id}/content`, method: "PUT", headers: { "Content-Type": ctype }, auth: true }
					: { url: `https://bucket.example/${id}.${ext}?sig=1`, method: "PUT", headers: { "Content-Type": ctype } },
				completeUrl: `https://acme.hoja.work/api/uploads/${id}/complete`,
			});
		}
		if (init.method === "PUT") {
			const id = /(blob\d+)/.exec(url)![1];
			stored.set(id, Buffer.from(init.body));
			return reply(200, {});
		}
		const m = /\/api\/uploads\/(blob\d+)\/complete$/.exec(url);
		if (m) {
			const body = JSON.parse(init.body);
			const ext = extOf.get(m[1])!;
			const key = `${m[1]}.${ext}`;
			return reply(200, {
				id: m[1], url: `/api/uploads/${key}`, absoluteUrl: `https://acme.hoja.work/api/uploads/${key}`,
				contentType: ext === "png" ? "image/png" : ext === "mp4" ? "video/mp4" : "application/pdf", size: stored.get(m[1])!.length,
				...(body.issueId ? { attachment: { id: `att-${m[1]}`, title: body.title } } : {}),
			});
		}
		return reply(404, { error: "not_found" });
	};
	return { fetch, calls, stored };
}

const dir = mkdtempSync(join(tmpdir(), "hoja-artifacts-"));
const shot = join(dir, "shot.png");
writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
const video = join(dir, "demo.mp4");
writeFileSync(video, Buffer.alloc(64, 7));
const svg = join(dir, "logo.svg");
writeFileSync(svg, "<svg/>");
mkdirSync(join(dir, "app", "artifacts", "opts"), { recursive: true });
for (let i = 1; i <= 15; i++) writeFileSync(join(dir, "app", "artifacts", "opts", `opt-${i}.png`), Buffer.from([i]));

function fakePi(cwd = dir) {
	const tools = new Map<string, any>();
	const ctx: any = {
		mode: "print", cwd, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {}, setStatus() {}, setWorkingMessage() {} },
		sessionManager: { getSessionId: () => "sess-1", getCwd: () => cwd, getEntries: () => [] },
	};
	const pi: any = { on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry() {}, sendUserMessage() {} };
	return { pi, ctx, tools };
}

describe("uploadFile", () => {
	it("begins, PUTs the bytes to storage without the Hoja token, and completes with the task", async () => {
		const d = fakeDeployment();
		const client = artifactClient({ url: env.HOJA_API_URL!, token: "tok", fetch: d.fetch });
		expect(client.origin).toBe("https://acme.hoja.work");
		const up = await uploadFile(client, shot, { issue: "HOJA-1", title: "Before", ttlDays: 7 });
		expect(up).toMatchObject({ url: "/api/uploads/blob1.png", absoluteUrl: "https://acme.hoja.work/api/uploads/blob1.png", markdown: "![Before](https://acme.hoja.work/api/uploads/blob1.png)", attachmentId: "att-blob1" });
		expect(d.stored.get("blob1")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
		const [begin, put, complete] = d.calls;
		expect(begin.headers.Authorization).toBe("Bearer tok");
		expect(JSON.parse(begin.body)).toEqual({ filename: "shot.png", size: 7, ttlDays: 7 });
		expect(put.method).toBe("PUT");
		expect(put.headers).toEqual({ "Content-Type": "image/png" });
		expect(JSON.parse(complete.body)).toEqual({ issueId: "HOJA-1", title: "Before" });
		expect(complete.headers.Authorization).toBe("Bearer tok");
	});

	it("sends the Hoja token on the PUT only when the server asks (put.auth)", async () => {
		const d = fakeDeployment({ putAuth: true });
		await uploadFile(artifactClient({ url: env.HOJA_API_URL!, token: "tok", fetch: d.fetch }), video);
		expect(d.calls[1].headers.Authorization).toBe("Bearer tok");
	});

	it("refuses SVG/HTML locally with the fix, and missing files", async () => {
		const client = artifactClient({ url: env.HOJA_API_URL!, token: "tok", fetch: fakeDeployment().fetch });
		await expect(uploadFile(client, svg)).rejects.toThrow(/refuses \.svg.*Render it to PNG/);
		await expect(uploadFile(client, join(dir, "nope.png"))).rejects.toThrow(/no such file/);
	});
});

describe("hoja_artifact_upload", () => {
	it("is registered with the no-local-paths guidance", () => {
		const h = fakePi();
		registerHojaArtifacts(h.pi, { env, fetch: fakeDeployment().fetch });
		const tool = h.tools.get("hoja_artifact_upload");
		expect(tool.parameters.required).toEqual(["paths"]);
		expect(Object.keys(tool.parameters.properties)).toEqual(["paths", "issue", "titles", "ttlDays"]);
		expect(HOJA_ARTIFACT_UPLOAD_CONTRACT.description).toMatch(/Never put a local path/);
		expect(HOJA_ARTIFACT_UPLOAD_CONTRACT.description).toMatch(/mediaUrl in hoja_decision_ask/);
		expect(HOJA_ARTIFACT_UPLOAD_CONTRACT.description).toMatch(/refuses SVG and HTML/);
	});

	it("uploads relative paths from the session cwd, returns url/absoluteUrl/markdown and per-file errors", async () => {
		const d = fakeDeployment();
		const h = fakePi();
		registerHojaArtifacts(h.pi, { env, fetch: d.fetch });
		const result = await h.tools.get("hoja_artifact_upload").execute("c1", { paths: ["shot.png", "demo.mp4", "logo.svg", "gone.png"], issue: "HOJA-841", titles: ["Shot"] }, undefined, undefined, h.ctx);
		expect(result.isError).toBeUndefined();
		const body = JSON.parse(result.content[0].text);
		expect(body.uploaded).toHaveLength(2);
		expect(body.uploaded[0]).toMatchObject({ path: "shot.png", url: "/api/uploads/blob1.png", absoluteUrl: "https://acme.hoja.work/api/uploads/blob1.png", markdown: "![Shot](https://acme.hoja.work/api/uploads/blob1.png)", attachmentId: "att-blob1" });
		expect(body.uploaded[1].markdown).toBe("[demo.mp4](https://acme.hoja.work/api/uploads/blob2.mp4)");
		expect(body.errors).toHaveLength(2);
		expect(body.errors[0]).toMatch(/logo\.svg.*PNG/);
		expect(body.errors[1]).toMatch(/gone\.png: no such file/);
	});

	it("errors when nothing uploaded or Hoja is not configured", async () => {
		const h = fakePi();
		registerHojaArtifacts(h.pi, { env, fetch: fakeDeployment().fetch });
		expect((await h.tools.get("hoja_artifact_upload").execute("c1", { paths: ["gone.png"] }, undefined, undefined, h.ctx)).isError).toBe(true);
		const bare = fakePi();
		registerHojaArtifacts(bare.pi, { env: {} as NodeJS.ProcessEnv });
		const r = await bare.tools.get("hoja_artifact_upload").execute("c1", { paths: [shot] }, undefined, undefined, bare.ctx);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/);
	});
});

describe("rewriteLocalMedia / localReferences", () => {
	it("uploads existing media once, swaps paths for URLs, leaves code and missing files alone", async () => {
		const d = fakeDeployment();
		const client = artifactClient({ url: env.HOJA_API_URL!, token: "tok", fetch: d.fetch, cwd: dir });
		const { args, uploaded } = await rewriteLocalMedia(client, {
			context: `See ${shot} and again ${shot}, also [clip](demo.mp4). Not here: missing.png, src/app.ts`,
			options: [{ label: "A", mediaUrl: shot }],
		}, "HOJA-9");
		expect(uploaded).toHaveLength(2);
		expect(args.context).toBe("See ![shot.png](https://acme.hoja.work/api/uploads/blob1.png) and again ![shot.png](https://acme.hoja.work/api/uploads/blob1.png), also [clip](https://acme.hoja.work/api/uploads/blob2.mp4). Not here: missing.png, src/app.ts");
		expect(args.options[0].mediaUrl).toBe("https://acme.hoja.work/api/uploads/blob1.png");
		expect(JSON.parse(d.calls.find((c) => c.url.endsWith("/complete"))!.body).issueId).toBe("HOJA-9");
	});

	it("finds what a person could never open, and ignores real URLs and cited source files", () => {
		expect(localReferences({ context: "open app/artifacts/hojatar-options/index.html" })).toEqual(["app/artifacts/hojatar-options/index.html"]);
		expect(localReferences("file:///srv/x.png, http://localhost:5173/opts, /tmp/a.png, ~/out/b.svg")).toEqual(
			expect.arrayContaining(["file:///srv/x.png", "http://localhost:5173/opts", "/tmp/a.png", "~/out/b.svg"]));
		expect(localReferences([
			"https://acme.hoja.work/api/uploads/blob1.png", "/api/uploads/blob1.png", "https://github.com/o/r/blob/abc/docs/index.html",
			"see /root/Work/x/app/hoja_server/decisions.py", "plain words",
		])).toEqual([]);
	});
});

/** Just enough of the decision server: record the create input. */
function decisionServer() {
	const created: any[] = [];
	const fetch: FetchLike = async (url, init) => {
		const body = JSON.parse(init.body);
		if (url.endsWith("/graphql")) {
			created.push(body.variables.i);
			return { status: 200, text: async () => JSON.stringify({ data: { taskDecisionCreate: { success: true, decision: { id: `dec-${created.length}`, status: "open", delivery: { state: "asked" } } } } }) };
		}
		return { status: 200, text: async () => JSON.stringify({ decision_id: "x", status: "open", delivery: "claimed", takeable: false }) };
	};
	return { created, fetch };
}

function decisionHost() {
	const server = decisionServer();
	const d = fakeDeployment();
	const h = fakePi();
	const handle = registerHojaDecision(h.pi, { api: new DecisionApi({ url: env.HOJA_API_URL!, token: "tok", fetch: server.fetch }), artifactFetch: d.fetch, env, version: "1", holdSeconds: 0 });
	const ask = (params: any) => h.tools.get("hoja_decision_ask").execute("c1", { task: "HOJA-837", question: "Which avatar?", ...params }, undefined, undefined, h.ctx);
	return { server, d, h, ask, stop: () => handle.delivery?.stop() };
}

describe("hoja_decision_ask and local files", () => {
	it("accepts 20 options with uploaded media (15 local PNGs uploaded and swapped in)", async () => {
		expect(MAX_OPTIONS).toBe(20);
		expect((HOJA_DECISION_ASK_CONTRACT.parameters.properties.options as any).maxItems).toBe(20);
		expect(HOJA_DECISION_ASK_CONTRACT.description).toMatch(/hoja_artifact_upload/);
		const x = decisionHost();
		const options = Array.from({ length: 20 }, (_, i) => ({ label: `Option ${i + 1}`, ...(i < 15 ? { mediaUrl: `app/artifacts/opts/opt-${i + 1}.png` } : {}) }));
		const result = await x.ask({ options });
		x.stop();
		expect(result.isError).toBeUndefined();
		const sent = x.server.created[0];
		expect(sent.options).toHaveLength(20);
		expect(sent.options[0].mediaUrl).toBe("https://acme.hoja.work/api/uploads/blob1.png");
		expect(sent.options[14].mediaUrl).toBe("https://acme.hoja.work/api/uploads/blob15.png");
		expect(sent.options[15].mediaUrl).toBeUndefined();
		expect(x.d.stored.size).toBe(15);
	});

	it("refuses 21 options", async () => {
		const x = decisionHost();
		const result = await x.ask({ options: Array.from({ length: 21 }, (_, i) => ({ label: `O${i}` })) });
		expect(result.isError).toBe(true);
		expect(x.server.created).toHaveLength(0);
	});

	it("refuses a decision that points at a local HTML/SVG file or path, with the fix", async () => {
		const x = decisionHost();
		for (const params of [
			{ context: "Open app/artifacts/hojatar-options/index.html to compare the 15 options." },
			{ options: [{ label: "A", mediaUrl: svg }] },
			{ question: "Which one? see file:///root/out/a.png" },
			{ context: "Preview at http://localhost:8080/options" },
		]) {
			const result = await x.ask(params);
			expect(result.isError).toBe(true);
			const body = JSON.parse(result.content[0].text);
			expect(body.error).toMatch(/local files the person cannot open/);
			expect(body.fix).toMatch(/hoja_artifact_upload/);
			expect(body.fix).toMatch(/mediaUrl/);
		}
		expect(x.server.created).toHaveLength(0);
		expect(x.d.stored.size).toBe(0);
	});

	it("uploads a local screenshot in the context and creates the decision with its link", async () => {
		const x = decisionHost();
		const result = await x.ask({ context: `Current state: ${shot}` });
		x.stop();
		expect(result.isError).toBeUndefined();
		expect(x.server.created[0].context).toBe("Current state: ![shot.png](https://acme.hoja.work/api/uploads/blob1.png)");
	});
});
