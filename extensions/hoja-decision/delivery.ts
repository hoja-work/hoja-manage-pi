/** Hoja decision delivery for Pi (HOJA-799-A-8): the client side of the server's hot path
 *  (Hoja-Cloud app/docs/decisions.md "Delivery").
 *
 *  One background long-poll per open bound decision (`wait`, chained, ≤25 s each) learns when the answer is
 *  takeable. Whoever is listening at that moment consumes it, cheapest first:
 *    1. the asking tool call, blocked in `hoja_decision_ask` (`wait_seconds`) → the answer is its tool result;
 *    2. the `agent_before_settle` hold (≤120 s) → a custom message the model reads as user input;
 *    3. nobody (the session is idle) → `pi.sendUserMessage(text, {deliverAs:"followUp"})`.
 *  Every consumer goes through `consume()`, which flips the local phase synchronously from `waiting` to `taking`,
 *  so exactly one of them calls `take`. The server's `take` is a compare-and-set, so a cold resume can never also
 *  deliver. Before handing text to the session the transcript is searched for the nonce prefix: a restart after the
 *  text already landed acknowledges instead of delivering twice. The ack itself is posted only once the nonce is in
 *  the session's own entries (checked at the next turn start or tool call). */

export type FetchLike = (url: string, init: {
	method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "error";
}) => Promise<{ status: number; text(): Promise<string> }>;

export const NONCE_PREFIX = "⟦hoja-decision ";
export const nonceNeedle = (decisionId: string) => `${NONCE_PREFIX}${decisionId}#`;
/** The server's long-poll cap. */
export const MAX_WAIT_MS = 25_000;

export type WaitState = {
	decision_id?: string; status?: string; delivery?: string | null; answered?: boolean; takeable?: boolean;
	canceled?: boolean; timed_out?: boolean; fence?: number | null; delivered_via?: string | null;
};
export type Taken = {
	decision_id: string; fence: number; nonce: string; text: string; chosen_option?: string | null;
	chosen_label?: string | null; answer?: string | null; replayed?: boolean;
};
export type Reply<T> = { status: number; body: T & { error?: string; message?: string } };

/** Graph endpoint `https://host/graphql` → REST origin `https://host`. */
export function originOf(graphqlUrl: string): string {
	const parsed = new URL(graphqlUrl);
	parsed.pathname = parsed.pathname.replace(/\/graphql\/?$/, "") || "/";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/$/, "");
}

export class DecisionApi {
	readonly origin: string;
	constructor(private readonly options: { url: string; token: string; fetch?: FetchLike; timeoutMs?: number }) {
		this.origin = originOf(options.url);
	}

	private headers(): Record<string, string> {
		const token = this.options.token.trim();
		return {
			Authorization: /^bearer /i.test(token) ? token : `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "hoja-manage-pi/decision",
		};
	}

	private async request(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json: any }> {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, timeoutMs);
		try {
			const fetchImpl = this.options.fetch ?? (globalThis.fetch as unknown as FetchLike);
			const res = await fetchImpl(url, {
				method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: controller.signal, redirect: "error",
			});
			const raw = await res.text();
			let json: any = {};
			try { json = raw ? JSON.parse(raw) : {}; } catch { json = {}; }
			return { status: res.status, json };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const { status, json } = await this.request(this.options.url, { query, variables }, this.options.timeoutMs ?? 20_000);
		if (status !== 200) throw new Error(`Hoja HTTP ${status}`);
		if (json.errors?.length) throw new Error(`Hoja: ${String(json.errors[0]?.message ?? "GraphQL error").slice(0, 300)}`);
		return json.data as T;
	}

	async post<T>(decisionId: string, action: "wait" | "take" | "delivered" | "ack" | "fail", body: Record<string, unknown>, signal?: AbortSignal): Promise<Reply<T>> {
		const timeout = action === "wait" ? Number(body.wait_ms ?? MAX_WAIT_MS) + 15_000 : this.options.timeoutMs ?? 20_000;
		const { status, json } = await this.request(`${this.origin}/api/decisions/${encodeURIComponent(decisionId)}/${action}`, body, timeout, signal);
		return { status, body: json };
	}
}

export type Phase = "waiting" | "taking" | "delivered" | "closed";
export type Tracked = {
	id: string; question: string; sessionId: string; waiterId: string;
	phase: Phase; ready: boolean; fence?: number; outcome?: "answered" | "canceled" | "timed_out" | "gone" | "taken_elsewhere";
	controller: AbortController; loop?: Promise<void>;
};
export type Consumed =
	| { kind: "deliver"; text: string; fence: number; nonce: string; chosenOption?: string | null; answer?: string | null }
	| { kind: "already"; fence: number }
	| { kind: "none"; reason: string };

export interface DeliveryHost {
	/** True when the session's own entries already contain this decision's nonce. */
	transcriptHas(decisionId: string): boolean;
	/** Stage 3: hand the framed text to the idle session. Returns false when no live session can take it. */
	followUp(text: string): boolean;
	/** Whether stage 3 may run now (an interactive session; a print run is disposed once its prompt resolves). */
	canFollowUp(): boolean;
	/** Persist a state change so a reload replays it. */
	journal?(entry: { id: string; phase: Phase; outcome?: string }): void;
	log?(message: string): void;
}

type Listener = { ids: Set<string> | "any"; resolve: (id: string | undefined) => void };
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
	if (signal?.aborted) return resolve();
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class DecisionDelivery {
	readonly decisions = new Map<string, Tracked>();
	private listeners: Listener[] = [];
	private readonly waitMs: number;
	private readonly backoffMs: number[];

	constructor(private readonly api: DecisionApi, private readonly host: DeliveryHost, options: { waitMs?: number; backoffMs?: number[] } = {}) {
		this.waitMs = Math.min(options.waitMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
		this.backoffMs = options.backoffMs ?? [1_000, 2_000, 5_000, 10_000];
	}

	/** A stable waiter id per (session, decision), used for every `wait` and `take`. A restarted process on the same
	 *  session presents the same id, so it can replay a `take` its predecessor won but never delivered. */
	static waiterId(sessionId: string, decisionId: string): string {
		return `pi:${sessionId}:${decisionId}`.slice(0, 128);
	}

	track(input: { id: string; question: string; sessionId: string }): Tracked {
		const existing = this.decisions.get(input.id);
		if (existing && existing.phase !== "closed") return existing;
		const tracked: Tracked = {
			...input, waiterId: DecisionDelivery.waiterId(input.sessionId, input.id),
			phase: "waiting", ready: false, controller: new AbortController(),
		};
		this.decisions.set(input.id, tracked);
		tracked.loop = this.poll(tracked);
		return tracked;
	}

	/** Open decisions this session still waits on. */
	waiting(): Tracked[] {
		return [...this.decisions.values()].filter((d) => d.phase === "waiting");
	}

	stop(): void {
		for (const d of this.decisions.values()) d.controller.abort();
		for (const l of this.listeners.splice(0)) l.resolve(undefined);
	}

	private close(d: Tracked, outcome: Tracked["outcome"]): void {
		d.phase = "closed";
		d.outcome = outcome;
		d.controller.abort();
		this.host.journal?.({ id: d.id, phase: "closed", outcome });
		this.notify(d.id);
	}

	private notify(id: string): void {
		const remaining: Listener[] = [];
		let handed = false;
		for (const l of this.listeners) {
			const one = this.decisions.get(id);
			const wants = l.ids === "any" ? one?.ready === true || one?.phase === "closed" : l.ids.has(id);
			if (!handed && wants) { handed = true; l.resolve(id); }
			else remaining.push(l);
		}
		this.listeners = remaining;
		const d = this.decisions.get(id);
		// Stage 3: no tool call and no settle hold is listening. Deliver into the idle session.
		if (!handed && d?.ready && d.phase === "waiting" && this.host.canFollowUp()) void this.followUp(d);
	}

	private async poll(d: Tracked): Promise<void> {
		let failures = 0;
		while (d.phase === "waiting" && !d.controller.signal.aborted) {
			let reply: Reply<WaitState>;
			try {
				reply = await this.api.post<WaitState>(d.id, "wait", { session_id: d.sessionId, waiter_id: d.waiterId, wait_ms: this.waitMs }, d.controller.signal);
			} catch {
				if (d.controller.signal.aborted) return;
				await sleep(this.backoffMs[Math.min(failures++, this.backoffMs.length - 1)], d.controller.signal);
				continue;
			}
			if (reply.status === 404) return this.close(d, "gone");
			if (reply.status !== 200) {
				await sleep(this.backoffMs[Math.min(failures++, this.backoffMs.length - 1)], d.controller.signal);
				continue;
			}
			failures = 0;
			const state = reply.body;
			if (state.canceled) return this.close(d, "canceled");
			if (state.timed_out) return this.close(d, "timed_out");
			if (state.takeable) {
				d.ready = true;
				this.notify(d.id);
				return;
			}
			const delivery = state.delivery ?? "";
			// A predecessor of this session (same waiter id) took it, or already delivered it: recover from the transcript.
			if ((delivery === "delivering" || delivery === "delivered") && state.delivered_via === "hot") {
				if (this.host.transcriptHas(d.id) && typeof state.fence === "number") {
					d.fence = state.fence;
					d.phase = "delivered";
					this.host.journal?.({ id: d.id, phase: "delivered" });
					await this.ackIfInTranscript(d.id);
					return;
				}
				if (delivery === "delivering") { d.ready = true; this.notify(d.id); return; }
			}
			if (["acknowledged", "failed", "timed_out", "canceled"].includes(delivery)) return this.close(d, delivery === "acknowledged" ? "answered" : delivery === "failed" ? "taken_elsewhere" : (delivery as any));
			if (delivery === "delivering" || delivery === "delivered") return this.close(d, "taken_elsewhere");
			// asked/claimed after a full hold: chain the next poll.
		}
	}

	/** Resolve with the first ready decision among `ids` (or any), or undefined after `timeoutMs`, an abort, or when
	 *  `interrupt()` turns true (checked every 250 ms, e.g. the person typed while the session held its settle). */
	awaitReady(ids: string[] | "any", timeoutMs: number, options: { signal?: AbortSignal; interrupt?: () => boolean } = {}): Promise<string | undefined> {
		const pool = ids === "any" ? [...this.decisions.values()] : ids.map((id) => this.decisions.get(id)).filter(Boolean) as Tracked[];
		// A named decision that closed (canceled, expired) answers its waiter at once; "any" only cares about answers.
		const now = pool.find((d) => d.phase === "waiting" && d.ready) ?? (ids === "any" ? undefined : pool.find((d) => d.phase === "closed"));
		if (now) return Promise.resolve(now.id);
		if (!pool.some((d) => d.phase === "waiting")) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			let done = false;
			const finish = (id: string | undefined) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				clearInterval(tick);
				options.signal?.removeEventListener("abort", onAbort);
				this.listeners = this.listeners.filter((l) => l !== listener);
				resolve(id);
			};
			const listener: Listener = { ids: ids === "any" ? "any" : new Set(ids), resolve: finish };
			const onAbort = () => finish(undefined);
			const timer = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
			const tick = setInterval(() => { if (options.interrupt?.()) finish(undefined); }, 250);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.listeners.push(listener);
		});
	}

	/** The single local gate: only the caller that flips `waiting → taking` calls `take`. */
	async consume(id: string): Promise<Consumed> {
		const d = this.decisions.get(id);
		if (!d) return { kind: "none", reason: "unknown" };
		if (d.phase === "closed") return { kind: "none", reason: d.outcome ?? "closed" };
		if (d.phase !== "waiting" || !d.ready) return { kind: "none", reason: d.phase };
		d.phase = "taking";
		let reply: Reply<Taken> | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				reply = await this.api.post<Taken>(id, "take", { session_id: d.sessionId, waiter_id: d.waiterId });
				break;
			} catch { await sleep(500 * (attempt + 1)); }
		}
		if (!reply) {
			// Transport failure: the same waiter can replay the take; go back to polling.
			d.phase = "waiting";
			d.ready = false;
			d.loop = this.poll(d);
			return { kind: "none", reason: "take_failed" };
		}
		if (reply.status !== 200) {
			this.close(d, reply.status === 404 ? "gone" : "taken_elsewhere");
			return { kind: "none", reason: reply.body.error ?? `http_${reply.status}` };
		}
		const taken = reply.body;
		d.fence = taken.fence;
		if (this.host.transcriptHas(id)) {
			d.phase = "delivered";
			this.host.journal?.({ id, phase: "delivered" });
			await this.ackIfInTranscript(id);
			return { kind: "already", fence: taken.fence };
		}
		return { kind: "deliver", text: taken.text, fence: taken.fence, nonce: taken.nonce, chosenOption: taken.chosen_option, answer: taken.answer };
	}

	/** The text was handed to the session (tool result returned, settle entry committed, follow-up queued). */
	async markDelivered(id: string): Promise<void> {
		const d = this.decisions.get(id);
		if (!d || d.fence === undefined) return;
		d.phase = "delivered";
		this.host.journal?.({ id, phase: "delivered" });
		try {
			await this.api.post(id, "delivered", { session_id: d.sessionId, fence: d.fence });
		} catch { this.host.log?.(`hoja decision ${id}: delivered report failed; ack will follow`); }
	}

	/** Ack every delivered decision whose nonce is now in the session's entries. Called on turn start and tool call. */
	async ackDelivered(): Promise<string[]> {
		const acked: string[] = [];
		for (const d of [...this.decisions.values()]) if (d.phase === "delivered" && await this.ackIfInTranscript(d.id)) acked.push(d.id);
		return acked;
	}

	private async ackIfInTranscript(id: string): Promise<boolean> {
		const d = this.decisions.get(id);
		if (!d || d.fence === undefined || !this.host.transcriptHas(id)) return false;
		try {
			const reply = await this.api.post(id, "ack", { session_id: d.sessionId, fence: d.fence });
			if (reply.status !== 200 && reply.status !== 409 && reply.status !== 404) return false;
		} catch { return false; }
		this.close(d, "answered");
		return true;
	}

	private async followUp(d: Tracked): Promise<void> {
		const consumed = await this.consume(d.id);
		if (consumed.kind !== "deliver") return;
		if (!this.host.followUp(consumed.text)) {
			// No session to take it right now: the holder stays silent and the server returns it to `answered` after 90 s.
			// Keep it ready: the same waiter may replay the take for the next settle hold or follow-up.
			this.host.log?.(`hoja decision ${d.id}: no live session for the follow-up`);
			d.phase = "waiting";
			return;
		}
		await this.markDelivered(d.id);
	}
}
