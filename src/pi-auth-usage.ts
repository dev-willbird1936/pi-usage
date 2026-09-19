import { Buffer } from "node:buffer";
import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SimpleUsageAmount, SimpleUsageLimit, SimpleUsageReport, SimpleUsageWindow } from "./simple-usage.ts";

/** Minimal context needed to resolve Pi and Claude Code usage credentials. */
export interface PiAuthUsageContext {
	readStoredCredential?: (provider: string) => {
		type?: string;
		access?: string;
		expires?: unknown;
		expiresAt?: unknown;
	} | undefined;
	/** Read Claude Code's OAuth token for Claude subscription usage. */
	readClaudeCodeAccessToken?: () => string | undefined;
	/** Read the full Claude Code OAuth credential so expired access tokens can refresh. */
	readClaudeCodeCredential?: () => ClaudeCodeCredential | undefined;
	/** Persist a refreshed Claude Code OAuth credential. */
	writeClaudeCodeCredential?: (updates: ClaudeCodeCredentialUpdate) => void;
	modelRegistry?: {
		getProviderAuth(provider: string): Promise<
			| {
					auth?: {
					apiKey?: string;
					headers?: Record<string, unknown>;
					baseUrl?: string;
				};
					source?: string;
					accountId?: string;
				}
			| undefined
		>;
	};
	signal?: AbortSignal;
}

export type PiUsageFetch = typeof fetch;

type PiAuth = { accessToken: string; accountId?: string };
export type ClaudeCodeCredential = {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	refreshTokenExpiresAt?: number;
};
export type ClaudeCodeCredentialUpdate = {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
};
type PercentBucket = { utilization?: number; resetsAt?: number };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const REQUEST_TIMEOUT_MS = 20_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_MONTHLY_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Providers with direct usage collectors authenticated by Pi. */
export const PI_AUTH_USAGE_PROVIDER_IDS = [
	"anthropic",
	"cursor",
	"deepseek",
	"kimi-coding",
	"openai-codex",
	"openrouter",
	"opencode-go",
	"xai-oauth",
] as const;

/** Provider IDs exposed by `/usage`; aliases are accepted by the command too. */
export const USAGE_PROVIDER_IDS = [...PI_AUTH_USAGE_PROVIDER_IDS, "claude-bridge"] as const;

/** Provider names that can route to one of the canonical usage collectors. */
const USAGE_PROVIDER_ALIASES: Record<string, string> = {
	anthropic: "anthropic",
	claude: "anthropic",
	"claude-code": "anthropic",
	"claude-bridge": "anthropic",
	xai: "xai-oauth",
	"xai-cliproxy": "xai-oauth",
	"cursor-cliproxy": "cursor",
	"deepseek-cliproxy": "deepseek",
	"kimi-code": "kimi-coding",
	"kimi-cliproxy": "kimi-coding",
	"openrouter-cliproxy": "openrouter",
	opencode: "opencode-go",
};

function normalizeUsageProvider(provider: string | undefined): string | undefined {
	const normalized = provider?.trim().toLowerCase();
	return normalized ? USAGE_PROVIDER_ALIASES[normalized] ?? normalized : undefined;
}

export function isPiAuthUsageProvider(provider: string | undefined): boolean {
	const normalized = normalizeUsageProvider(provider);
	return normalized !== undefined && PI_AUTH_USAGE_PROVIDER_IDS.includes(normalized as (typeof PI_AUTH_USAGE_PROVIDER_IDS)[number]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Claude Code CLI login file: `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`. */
function claudeCodeCredentialsPath(): string {
	const configuredDir = typeof process !== "undefined" ? process.env.CLAUDE_CONFIG_DIR?.trim() : undefined;
	return join(configuredDir || join(homedir(), ".claude"), ".credentials.json");
}

/** Read Claude Code's subscription OAuth credential from the Claude Code CLI file. */
export function readClaudeCodeCredential(): ClaudeCodeCredential | undefined {
	try {
		const payload = JSON.parse(readFileSync(claudeCodeCredentialsPath(), "utf8")) as unknown;
		const oauth = isRecord(payload) && isRecord(payload.claudeAiOauth) ? payload.claudeAiOauth : undefined;
		const accessToken = text(oauth?.accessToken);
		if (!accessToken) return undefined;
		const refreshToken = text(oauth?.refreshToken);
		const expiresAt = timestamp(oauth?.expiresAt);
		const refreshTokenExpiresAt = timestamp(oauth?.refreshTokenExpiresAt);
		return {
			accessToken,
			...(refreshToken ? { refreshToken } : {}),
			...(expiresAt !== undefined ? { expiresAt } : {}),
			...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Read the OAuth token used by Claude Code (and Claude Bridge). */
export function readClaudeCodeAccessToken(): string | undefined {
	return readClaudeCodeCredential()?.accessToken;
}

/** Update only Claude Code's OAuth fields, preserving the rest of the file. */
export function writeClaudeCodeCredential(updates: ClaudeCodeCredentialUpdate): void {
	const credentialsPath = claudeCodeCredentialsPath();
	const payload = JSON.parse(readFileSync(credentialsPath, "utf8")) as unknown;
	if (!isRecord(payload) || !isRecord(payload.claudeAiOauth)) throw new Error("Claude Code credential file has an invalid shape");
	payload.claudeAiOauth = {
		...payload.claudeAiOauth,
		accessToken: updates.accessToken,
		...(updates.refreshToken ? { refreshToken: updates.refreshToken } : {}),
		...(updates.expiresAt !== undefined ? { expiresAt: updates.expiresAt } : {}),
	};
	const temporaryPath = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		try {
			renameSync(temporaryPath, credentialsPath);
		} catch {
			// Windows cannot rename over an existing file; copy then remove the temp.
			copyFileSync(temporaryPath, credentialsPath);
		}
	} finally {
		try { unlinkSync(temporaryPath); } catch { /* already replaced */ }
	}
}

function number(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000;
	if (typeof value !== "string" || !value.trim()) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? (numeric > 1_000_000_000_000 ? numeric : numeric * 1000) : undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function usageStatus(usedFraction: number): "ok" | "warning" | "exhausted" {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function percentAmount(value: number): SimpleUsageAmount {
	const used = Math.min(Math.max(value, 0), 100);
	const usedFraction = used / 100;
	return {
		used,
		limit: 100,
		remaining: 100 - used,
		usedFraction,
		remainingFraction: 1 - usedFraction,
		unit: "percent",
	};
}

function boundedAmount(used: number, limit: number, unit: string): SimpleUsageAmount | undefined {
	if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return undefined;
	const usedFraction = Math.min(Math.max(used / limit, 0), 1);
	return {
		used,
		limit,
		remaining: Math.max(0, limit - used),
		usedFraction,
		remainingFraction: 1 - usedFraction,
		unit,
	};
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type JsonFetchResult = { value: unknown } | { error: string; status?: number; body?: unknown };

function safeUsageError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n]+/g, " ").trim().slice(0, 160) || "request failed";
}

function failedReport(provider: string, error: string): SimpleUsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [],
		error: `Usage unavailable: ${safeUsageError(error)}`,
	};
}

async function fetchJson(
	fetchImpl: PiUsageFetch,
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
	request: { method?: "GET" | "POST"; body?: string } = {},
): Promise<JsonFetchResult> {
	try {
		const response = await fetchImpl(url, {
			method: request.method,
			headers,
			...(request.body !== undefined ? { body: request.body } : {}),
			redirect: "error",
			signal: requestSignal(signal),
		});
		if (!response.ok) {
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			return { error: `HTTP ${response.status}`, status: response.status, ...(body !== undefined ? { body } : {}) };
		}
		try {
			return { value: await response.json() };
		} catch {
			return { error: "invalid JSON response" };
		}
	} catch (error) {
		return { error: safeUsageError(error) };
	}
}

async function refreshClaudeCodeAuth(
	context: PiAuthUsageContext,
	fetchImpl: PiUsageFetch,
	credential: ClaudeCodeCredential,
): Promise<PiAuth | undefined> {
	const refreshToken = text(credential.refreshToken);
	if (!refreshToken) return undefined;
	const response = await fetchJson(
		fetchImpl,
		CLAUDE_OAUTH_TOKEN_URL,
		{ Accept: "application/json", "Content-Type": "application/json" },
		context.signal,
		{
			method: "POST",
			body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CODE_CLIENT_ID }),
		},
	);
	if ("error" in response || !isRecord(response.value)) return undefined;
	const accessToken = text(response.value.access_token);
	if (!accessToken) return undefined;
	const rotatedRefreshToken = text(response.value.refresh_token);
	const expiresIn = number(response.value.expires_in);
	const updates: ClaudeCodeCredentialUpdate = {
		accessToken,
		...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
		...(expiresIn !== undefined && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
	};
	try {
		context.writeClaudeCodeCredential?.(updates);
	} catch {
		// A refreshed token still works for this request even if persistence fails.
	}
	return { accessToken };
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted && typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function hasOfficialOrigin(baseUrl: string | undefined, origins: readonly string[]): boolean {
	if (!baseUrl) return true;
	try {
		return origins.includes(new URL(baseUrl).origin.toLowerCase());
	} catch {
		return false;
	}
}

/** Resolve credentials through Pi first so its OAuth resolver can refresh expired tokens. */
async function resolvePiAuth(
	context: PiAuthUsageContext,
	provider: string,
	options: { oauthOnly?: boolean; origins?: readonly string[] } = {},
): Promise<PiAuth | undefined> {
	let resolved:
		| {
				auth?: { apiKey?: string; headers?: Record<string, unknown>; baseUrl?: string };
				source?: string;
				accountId?: string;
		  }
		| undefined;
	try {
		resolved = await context.modelRegistry?.getProviderAuth(provider);
	} catch {
		resolved = undefined;
	}
	if (resolved && (!options.oauthOnly || /oauth/i.test(resolved.source ?? "")) && hasOfficialOrigin(resolved.auth?.baseUrl, options.origins ?? [])) {
		const accessToken = text(resolved.auth?.apiKey);
		if (accessToken) {
			const accountId = text(resolved.accountId) ?? headerValue(resolved.auth?.headers, "chatgpt-account-id");
			return { accessToken, ...(accountId ? { accountId } : {}) };
		}
	}

	return storedOAuthAuth(context, provider);
}

function storedOAuthAuth(context: PiAuthUsageContext, provider: string): PiAuth | undefined {
	try {
		const stored = context.readStoredCredential?.(provider);
		const expiry = timestamp(stored?.expiresAt ?? stored?.expires);
		const accessToken = text(stored?.access);
		if (stored?.type === "oauth" && accessToken && (expiry === undefined || expiry > Date.now())) {
			return { accessToken };
		}
	} catch {
		// No usable stored credential.
	}
	return undefined;
}

function isCursorJwt(token: string): boolean {
	const payload = jwtPayload(token);
	if (!payload) return false;
	const iss = (text(payload.iss) ?? "").toLowerCase();
	const aud = (text(payload.aud) ?? "").toLowerCase();
	return iss.includes("cursor.") || aud.includes("cursor.");
}

function uniqueAuths(auths: Array<PiAuth | undefined>): PiAuth[] {
	const out: PiAuth[] = [];
	for (const auth of auths) {
		if (auth && !out.some(existing => existing.accessToken === auth.accessToken)) out.push(auth);
	}
	return out;
}

function bearerHeaders(auth: PiAuth): Record<string, string> {
	return { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" };
}

function parsePercentBucket(value: unknown): PercentBucket | undefined {
	if (!isRecord(value)) return undefined;
	const utilization = number(value.utilization);
	const resetsAt = timestamp(value.resets_at);
	return utilization === undefined && resetsAt === undefined ? undefined : { utilization, resetsAt };
}

function makeWindow(id: string, label: string, durationMs: number, resetsAt?: number): SimpleUsageWindow {
	return { id, label, durationMs, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function makePercentLimit(
	id: string,
	label: string,
	bucket: PercentBucket | undefined,
	window: SimpleUsageWindow,
	tier?: string,
): SimpleUsageLimit | undefined {
	if (bucket?.utilization === undefined) return undefined;
	const amount = percentAmount(bucket.utilization);
	return {
		id,
		label,
		scope: { windowId: window.id, shared: tier === undefined, ...(tier ? { tier } : {}) },
		window,
		amount,
		status: usageStatus(amount.usedFraction ?? 0),
	};
}

function parseClaudeIdentity(payload: Record<string, unknown>): {
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
} {
	const account = isRecord(payload.account) ? payload.account : undefined;
	const user = isRecord(payload.user) ? payload.user : undefined;
	const organization = isRecord(payload.organization) ? payload.organization : undefined;
	return {
		accountId:
			text(payload.account_id) ??
			text(payload.accountId) ??
			text(payload.user_id) ??
			text(payload.userId) ??
			text(account?.uuid) ??
			text(account?.id) ??
			text(user?.uuid) ??
			text(user?.id),
		email: (text(payload.email) ?? text(payload.user_email) ?? text(account?.email) ?? text(user?.email))?.toLowerCase(),
		orgId: text(payload.org_id) ?? text(payload.orgId) ?? text(organization?.uuid) ?? text(organization?.id),
		orgName: text(payload.org_name) ?? text(payload.orgName) ?? text(organization?.name),
	};
}

function claudeLimitFromEntry(
	entry: Record<string, unknown>,
	index: number,
): { kind: string; displayName?: string; bucket: PercentBucket } | undefined {
	const utilization = number(entry.percent);
	const resetsAt = timestamp(entry.resets_at);
	if (utilization === undefined && resetsAt === undefined) return undefined;
	const scope = isRecord(entry.scope) ? entry.scope : undefined;
	const model = isRecord(scope?.model) ? scope.model : undefined;
	return {
		kind: text(entry.kind) ?? `entry-${index}`,
		displayName: text(model?.display_name),
		bucket: { utilization, resetsAt },
	};
}

function claudeMoney(value: unknown): { value: number; currency?: string } | undefined {
	if (!isRecord(value)) return undefined;
	const minor = number(value.amount_minor);
	const exponent = number(value.exponent);
	if (minor === undefined || exponent === undefined || minor < 0 || exponent < 0) return undefined;
	const result = minor / 10 ** exponent;
	return Number.isFinite(result) ? { value: result, currency: text(value.currency) } : undefined;
}

function claudeExtraLimit(payload: Record<string, unknown>): SimpleUsageLimit | undefined {
	const spend = isRecord(payload.spend) ? payload.spend : undefined;
	if (!spend?.enabled) return undefined;
	const usedMoney = claudeMoney(spend.used);
	const limitMoney = claudeMoney(spend.limit);
	if (
		!usedMoney ||
		!limitMoney ||
		(usedMoney.currency && usedMoney.currency.toUpperCase() !== "USD") ||
		(limitMoney.currency && limitMoney.currency.toUpperCase() !== "USD")
	) return undefined;
	const amount = boundedAmount(usedMoney.value, limitMoney.value, "usd");
	return amount
		? {
				id: "anthropic:extra",
				label: "Claude Extra Usage",
				scope: { windowId: "extra" },
				amount,
				status: usageStatus(amount.usedFraction ?? 0),
			}
		: undefined;
}

function claudeCodeAuth(context: PiAuthUsageContext): PiAuth | undefined {
	try {
		const accessToken = text(context.readClaudeCodeAccessToken?.());
		return accessToken ? { accessToken } : undefined;
	} catch {
		return undefined;
	}
}

async function fetchClaudeUsage(
	context: PiAuthUsageContext,
	fetchImpl: PiUsageFetch,
): Promise<SimpleUsageReport | undefined> {
	const piAuth = await resolvePiAuth(context, "anthropic", { oauthOnly: true, origins: ["https://api.anthropic.com"] });
	const claudeCredential = context.readClaudeCodeCredential?.();
	const candidates: Array<PiAuth & { source: "claude-code" | "pi" }> = [];
	const addCandidate = (auth: PiAuth | undefined, source: "claude-code" | "pi"): void => {
		if (auth && !candidates.some(existing => existing.accessToken === auth.accessToken)) {
			candidates.push({ ...auth, source });
		}
	};
	let refreshedClaudeCode = false;
	let claudeAuth = claudeCodeAuth(context);
	if (claudeCredential?.accessToken) claudeAuth = { accessToken: claudeCredential.accessToken };
	if (
		claudeCredential?.expiresAt !== undefined &&
		claudeCredential.expiresAt <= Date.now() + 30_000
	) {
		const refreshed = await refreshClaudeCodeAuth(context, fetchImpl, claudeCredential);
		if (refreshed) {
			claudeAuth = refreshed;
			refreshedClaudeCode = true;
		}
	}
	addCandidate(claudeAuth, "claude-code");
	addCandidate(piAuth, "pi");
	if (candidates.length === 0) return undefined;

	const headersFor = (accessToken: string): Record<string, string> => ({
		accept: "application/json, text/plain, */*",
		"content-type": "application/json",
		"anthropic-beta":
			"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
		"user-agent": "claude-cli/2.1.220 (external, cli)",
		authorization: `Bearer ${accessToken}`,
	});

	let lastError: string | undefined;
	for (let index = 0; index < candidates.length; index++) {
		const auth = candidates[index];
		const [usageResponse, profileResponse] = await Promise.all([
			fetchJson(fetchImpl, CLAUDE_USAGE_URL, headersFor(auth.accessToken), context.signal),
			fetchJson(fetchImpl, CLAUDE_PROFILE_URL, headersFor(auth.accessToken), context.signal),
		]);
		if ("error" in usageResponse) {
			lastError = usageResponse.error;
			if ((usageResponse.status === 401 || usageResponse.status === 403) && auth.source === "claude-code" && !refreshedClaudeCode && claudeCredential) {
				const refreshed = await refreshClaudeCodeAuth(context, fetchImpl, claudeCredential);
				refreshedClaudeCode = true;
				if (refreshed) candidates.splice(index + 1, 0, { ...refreshed, source: "claude-code" });
			}
			if (usageResponse.status === 401 || usageResponse.status === 403) continue;
			return failedReport("anthropic", usageResponse.error);
		}
		const usagePayload = usageResponse.value;
		if (!isRecord(usagePayload)) return failedReport("anthropic", "invalid usage payload");
		const profilePayload = "value" in profileResponse ? profileResponse.value : undefined;
		const notes = "error" in profileResponse ? [`Profile unavailable: ${profileResponse.error}`] : undefined;
		const authSource = auth.source;

		const entries = Array.isArray(usagePayload.limits)
		? usagePayload.limits
				.map((entry, index) => (isRecord(entry) ? claudeLimitFromEntry(entry, index) : undefined))
				.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
		: [];
	const session = parsePercentBucket(usagePayload.five_hour) ?? entries.find(entry => entry.kind === "session")?.bucket;
	const weekly = parsePercentBucket(usagePayload.seven_day) ?? entries.find(entry => entry.kind === "weekly_all")?.bucket;
	const limits: SimpleUsageLimit[] = [];
	const add = (limit: SimpleUsageLimit | undefined): void => {
		if (limit && !limits.some(existing => existing.id === limit.id)) limits.push(limit);
	};
	add(makePercentLimit("anthropic:5h", "Claude 5 Hour", session, makeWindow("5h", "5 Hour", 5 * HOUR_MS, session?.resetsAt)));
	add(makePercentLimit("anthropic:7d", "Claude 7 Day", weekly, makeWindow("7d", "7 Day", WEEK_MS, weekly?.resetsAt)));

	for (const [tier, key, label] of [
		["opus", "seven_day_opus", "Opus"],
		["sonnet", "seven_day_sonnet", "Sonnet"],
	] as const) {
		const bucket = parsePercentBucket(usagePayload[key]);
		add(makePercentLimit(`anthropic:7d:${tier}`, `Claude 7 Day (${label})`, bucket, makeWindow("7d", "7 Day", WEEK_MS, bucket?.resetsAt), tier));
	}
	const scopedTiers = new Set<string>();
	for (const entry of entries) {
		if (entry.kind !== "weekly_scoped" || !entry.displayName) continue;
		const tier = entry.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		if (!tier || scopedTiers.has(tier)) continue;
		scopedTiers.add(tier);
		add(
			makePercentLimit(
				`anthropic:7d:${tier}`,
				`Claude 7 Day (${entry.displayName})`,
				entry.bucket,
				makeWindow("7d", "7 Day", WEEK_MS, entry.bucket.resetsAt),
				tier,
			),
		);
	}
	add(claudeExtraLimit(usagePayload));
	if (limits.length === 0) return failedReport("anthropic", "no recognized usage limits");

	const usageIdentity = parseClaudeIdentity(usagePayload);
	const profileIdentity = isRecord(profilePayload) ? parseClaudeIdentity(profilePayload) : {};
	const identity = {
		accountId: usageIdentity.accountId ?? profileIdentity.accountId,
		email: usageIdentity.email ?? profileIdentity.email,
		orgId: usageIdentity.orgId ?? profileIdentity.orgId,
		orgName: usageIdentity.orgName ?? profileIdentity.orgName,
	};
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: {
			authSource,
			...(identity.accountId ? { accountId: identity.accountId } : {}),
			...(identity.email ? { email: identity.email } : {}),
			...(identity.orgId ? { orgId: identity.orgId } : {}),
			...(identity.orgName ? { orgName: identity.orgName } : {}),
		},
	};
	}
	return lastError ? failedReport("anthropic", lastError) : undefined;
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) return undefined;
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function xaiAmount(value: unknown): number | undefined {
	return isRecord(value) ? number(value.val) : undefined;
}

function xaiWindow(start: unknown, end: unknown, id: string, label: string): SimpleUsageWindow | undefined {
	const startAt = timestamp(start);
	const resetAt = timestamp(end);
	if (startAt === undefined || resetAt === undefined || resetAt <= startAt) return undefined;
	return { id, label, durationMs: resetAt - startAt, resetsAt: resetAt };
}

function xaiProductName(value: string): string {
	if (value === "GrokBuild") return "Grok Build";
	if (value === "Api") return "API";
	return value;
}

async function fetchXaiUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiAuth(context, "xai", { oauthOnly: true, origins: ["https://api.x.ai"] });
	if (!auth) return undefined;
	const headers = {
		Authorization: `Bearer ${auth.accessToken}`,
		Accept: "application/json",
		"X-XAI-Token-Auth": "xai-grok-cli",
	};
	const [weeklyResponse, identityResponse] = await Promise.all([
		fetchJson(fetchImpl, XAI_BILLING_URL, headers, context.signal),
		fetchJson(fetchImpl, XAI_USERINFO_URL, { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" }, context.signal),
	]);
	const errors: string[] = [];
	if ("error" in weeklyResponse) errors.push(`Weekly billing unavailable: ${weeklyResponse.error}`);
	if ("error" in identityResponse) errors.push(`Identity unavailable: ${identityResponse.error}`);
	const weeklyPayload = "value" in weeklyResponse ? weeklyResponse.value : undefined;
	const identityPayload = "value" in identityResponse ? identityResponse.value : undefined;
	const weeklyConfig = isRecord(weeklyPayload) && isRecord(weeklyPayload.config) ? weeklyPayload.config : undefined;
	const identity = isRecord(identityPayload) ? identityPayload : undefined;
	const tokenIdentity = jwtPayload(auth.accessToken);
	const accountId = text(identity?.sub) ?? text(tokenIdentity?.sub);
	const email = text(identity?.email)?.toLowerCase();
	const limits: SimpleUsageLimit[] = [];
	const period = weeklyConfig && isRecord(weeklyConfig.currentPeriod) ? weeklyConfig.currentPeriod : undefined;
	const weeklyWindow = period ? xaiWindow(period.start, period.end, "1w", "Weekly") : undefined;
	const reportedWeeklyPercent = weeklyConfig ? number(weeklyConfig.creditUsagePercent) : undefined;
	const inferredWeeklyPercent =
		reportedWeeklyPercent === undefined && weeklyWindow?.resetsAt !== undefined && weeklyWindow.resetsAt > Date.now();
	const weeklyPercent = reportedWeeklyPercent ?? (inferredWeeklyPercent ? 0 : undefined);
	if (
		weeklyWindow &&
		weeklyPercent !== undefined &&
		weeklyPercent >= 0 &&
		weeklyPercent <= 100 &&
		weeklyConfig
	) {
		const scope = { windowId: weeklyWindow.id, shared: true, ...(accountId ? { accountId } : {}) };
		const overall = percentAmount(weeklyPercent);
		limits.push({ id: "xai-oauth:credits:1w", label: "SuperGrok Weekly Credits", scope, window: weeklyWindow, amount: overall, status: usageStatus(overall.usedFraction ?? 0) });
		if (Array.isArray(weeklyConfig.productUsage)) {
			for (const item of weeklyConfig.productUsage) {
				if (!isRecord(item)) continue;
				const product = text(item.product);
				const productPercent = number(item.usagePercent);
				const slug = product?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
				if (!product || !slug || productPercent === undefined || productPercent < 0 || productPercent > 100) continue;
				const amount = percentAmount(productPercent);
				limits.push({ id: `xai-oauth:product:${slug}:1w`, label: `${xaiProductName(product)} (Weekly)`, scope, window: weeklyWindow, amount, status: usageStatus(amount.usedFraction ?? 0) });
			}
		}
		const onDemandCap = xaiAmount(weeklyConfig.onDemandCap);
		const onDemandUsed = xaiAmount(weeklyConfig.onDemandUsed);
		if (onDemandCap !== undefined && onDemandUsed !== undefined && onDemandCap > 0) {
			const amount = boundedAmount(onDemandUsed, onDemandCap, "unknown");
			if (amount) limits.push({ id: "xai-oauth:on-demand", label: "On-demand", scope: { shared: true, ...(accountId ? { accountId } : {}) }, amount, status: usageStatus(amount.usedFraction ?? 0) });
		}
	}

	const shouldProbeMonthly = limits.length === 0 || weeklyConfig?.isUnifiedBillingUser === true;
	if (shouldProbeMonthly) {
		const monthlyResponse = await fetchJson(fetchImpl, XAI_MONTHLY_BILLING_URL, headers, context.signal);
		if ("error" in monthlyResponse) errors.push(`Monthly billing unavailable: ${monthlyResponse.error}`);
		const monthlyPayload = "value" in monthlyResponse ? monthlyResponse.value : undefined;
		const monthlyConfig = isRecord(monthlyPayload) && isRecord(monthlyPayload.config) ? monthlyPayload.config : undefined;
		const monthlyWindow = monthlyConfig ? xaiWindow(monthlyConfig.billingPeriodStart, monthlyConfig.billingPeriodEnd, "1mo", "Monthly") : undefined;
		const used = monthlyConfig ? xaiAmount(monthlyConfig.used) : undefined;
		const limit = monthlyConfig ? xaiAmount(monthlyConfig.monthlyLimit) : undefined;
		const amount = used !== undefined && limit !== undefined ? boundedAmount(used, limit, "unknown") : undefined;
		if (monthlyWindow && amount) {
			limits.push({ id: "xai-oauth:included:1mo", label: "SuperGrok Monthly Included", scope: { windowId: monthlyWindow.id, shared: true, ...(accountId ? { accountId } : {}) }, window: monthlyWindow, amount, status: usageStatus(amount.usedFraction ?? 0) });
		}
	}
	if (limits.length === 0) return failedReport("xai-oauth", errors.join("; ") || "no recognized usage limits");
	return {
		provider: "xai-oauth",
		fetchedAt: Date.now(),
		limits,
		...(errors.length > 0 ? { notes: errors } : {}),
		metadata: { authSource: "pi", ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) },
	};
}

function cursorWindow(payload: Record<string, unknown>): SimpleUsageWindow | undefined {
	const start = timestamp(payload.billingCycleStart);
	const end = timestamp(payload.billingCycleEnd);
	if (start === undefined || end === undefined || end <= start) return undefined;
	return { id: "monthly", label: "Monthly", durationMs: end - start, resetsAt: end };
}

function cursorMoneyAmount(bucket: Record<string, unknown>): SimpleUsageAmount | undefined {
	const used = number(bucket.used) ?? number(bucket.includedSpend);
	const limit = number(bucket.limit);
	if (used === undefined || limit === undefined || limit <= 0) return undefined;
	return boundedAmount(used / 100, limit / 100, "usd");
}

function cursorLimit(
	id: string,
	label: string,
	bucket: Record<string, unknown> | undefined,
	window: SimpleUsageWindow | undefined,
): SimpleUsageLimit | undefined {
	if (!bucket) return undefined;
	const percent = number(bucket.totalPercentUsed);
	const amount = percent !== undefined ? percentAmount(percent) : cursorMoneyAmount(bucket);
	if (!amount) return undefined;
	return {
		id,
		label,
		scope: { shared: true, ...(window?.id ? { windowId: window.id } : {}) },
		...(window ? { window } : {}),
		amount,
		status: usageStatus(amount.usedFraction ?? 0),
	};
}

async function fetchCursorUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const registry = await resolvePiAuth(context, "cursor", { origins: ["https://api2.cursor.sh"] });
	const stored = storedOAuthAuth(context, "cursor");
	const candidates = uniqueAuths([
		...[registry, stored].filter((auth): auth is PiAuth => Boolean(auth && isCursorJwt(auth.accessToken))),
		...[registry, stored].filter((auth): auth is PiAuth => Boolean(auth && !isCursorJwt(auth.accessToken))),
	]);
	if (candidates.length === 0) return undefined;

	let lastError: string | undefined;
	for (const auth of candidates) {
		const response = await fetchJson(
			fetchImpl,
			CURSOR_USAGE_URL,
			{ ...bearerHeaders(auth), "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
			context.signal,
			{ method: "POST", body: "{}" },
		);
		if ("error" in response) {
			lastError = response.error;
			if (response.status === 401 || response.status === 403) continue;
			return failedReport("cursor", response.error);
		}
		const report = parseCursorUsagePayload(response.value);
		if (report) return report;
		lastError = "no recognized usage limits";
	}
	return failedReport("cursor", lastError ?? "no recognized usage limits");
}

function parseCursorUsagePayload(value: unknown): SimpleUsageReport | undefined {
	if (!isRecord(value)) return undefined;
	const window = cursorWindow(value);
	const plan = isRecord(value.planUsage) ? value.planUsage : undefined;
	const individual = isRecord(value.individualUsage) ? value.individualUsage : undefined;
	const limits: SimpleUsageLimit[] = [];
	const add = (limit: SimpleUsageLimit | undefined): void => {
		if (limit) limits.push(limit);
	};
	add(cursorLimit("cursor:plan", "Cursor included usage", plan, window));
	if (plan) {
		const autoPercent = number(plan.autoPercentUsed);
		if (autoPercent !== undefined) {
			const amount = percentAmount(autoPercent);
			add({ id: "cursor:usd:individual-auto", label: "Cursor Models", scope: { windowId: window?.id, shared: false }, ...(window ? { window } : {}), amount, status: usageStatus(amount.usedFraction ?? 0) });
		}
		const apiPercent = number(plan.apiPercentUsed);
		const planLimit = number(plan.limit);
		const apiAmount =
			apiPercent !== undefined && planLimit !== undefined && planLimit > 0
				? boundedAmount((planLimit * Math.min(Math.max(apiPercent, 0), 100)) / 100 / 100, planLimit / 100, "usd")
				: apiPercent !== undefined
					? percentAmount(apiPercent)
					: undefined;
		if (apiAmount) add({ id: "cursor:usd:individual-api", label: "Other Models", scope: { windowId: window?.id, shared: false }, ...(window ? { window } : {}), amount: apiAmount, status: usageStatus(apiAmount.usedFraction ?? 0) });
	}
	const onDemand = individual && isRecord(individual.onDemand) ? individual.onDemand : undefined;
	add(cursorLimit("cursor:on-demand", "Cursor on-demand", onDemand, undefined));
	if (limits.length === 0) return undefined;
	return {
		provider: "cursor",
		fetchedAt: Date.now(),
		limits,
		metadata: {
			authSource: "pi",
			...(text(value.membershipType) ? { membershipType: text(value.membershipType) } : {}),
		},
	};
}

function codexLimit(
	groupId: string,
	groupLabel: string,
	position: "primary" | "secondary",
	value: unknown,
): SimpleUsageLimit | undefined {
	if (!isRecord(value)) return undefined;
	const used = number(value.used_percent);
	if (used === undefined) return undefined;
	const seconds = number(value.limit_window_seconds);
	const resetsAt = timestamp(value.reset_at);
	const id = groupId === "openai-codex" ? `openai-codex:${position}` : `openai-codex:${groupId}:${position}`;
	const window: SimpleUsageWindow = {
		id,
		label: position === "primary" ? "Primary" : "Secondary",
		...(seconds !== undefined && seconds > 0 ? { durationMs: seconds * 1000 } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
	const amount = percentAmount(used);
	return {
		id,
		label: groupId === "openai-codex" && seconds === WEEK_MS / 1000 ? "7 days" : `${groupLabel} ${position}`,
		scope: { windowId: id, shared: groupId === "openai-codex", ...(groupId !== "openai-codex" ? { tier: groupId } : {}) },
		window,
		amount,
		status: usageStatus(amount.usedFraction ?? 0),
	};
}

async function fetchCodexUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiAuth(context, "openai-codex", { oauthOnly: true, origins: ["https://chatgpt.com"] });
	if (!auth) return undefined;
	const headers = { ...bearerHeaders(auth), originator: "pi", ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}) };
	const response = await fetchJson(fetchImpl, CODEX_USAGE_URL, headers, context.signal);
	if ("error" in response) return failedReport("openai-codex", response.error);
	const payload = response.value;
	if (!isRecord(payload)) return failedReport("openai-codex", "invalid usage payload");
	const limits: SimpleUsageLimit[] = [];
	const addGroup = (groupId: string, groupLabel: string, value: unknown): void => {
		if (!isRecord(value)) return;
		for (const position of ["primary", "secondary"] as const) {
			const limit = codexLimit(groupId, groupLabel, position, value[position === "primary" ? "primary_window" : "secondary_window"]);
			if (limit) limits.push(limit);
		}
	};
	addGroup("openai-codex", "Codex", payload.rate_limit);
	if (Array.isArray(payload.additional_rate_limits)) {
		for (const item of payload.additional_rate_limits) {
			if (!isRecord(item)) continue;
			const groupId = text(item.metered_feature) ?? text(item.limit_name);
			if (groupId) addGroup(groupId, text(item.limit_name) ?? groupId, item.rate_limit);
		}
	}
	const credits = isRecord(payload.credits) ? payload.credits : undefined;
	const balance = credits?.has_credits === true ? number(credits.balance) : undefined;
	if (balance !== undefined) limits.push({ id: "openai-codex:credits", label: "Codex credits", amount: { remaining: balance, unit: "count" }, status: "ok" });
	if (limits.length === 0) return failedReport("openai-codex", "no recognized usage limits");
	const tokenIdentity = jwtPayload(auth.accessToken);
	const accountId = text(payload.account_id) ?? auth.accountId ?? text(tokenIdentity?.account_id);
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits,
		metadata: {
			authSource: "pi",
			...(text(payload.email) ? { email: text(payload.email) } : {}),
			...(text(payload.plan_type) ? { planType: text(payload.plan_type) } : {}),
			...(accountId ? { accountId } : {}),
		},
	};
}

function kimiWindow(raw: unknown, fallbackId: string, fallbackLabel: string, resetValue?: unknown): SimpleUsageWindow | undefined {
	if (!isRecord(raw)) {
		const resetsAt = timestamp(resetValue);
		return fallbackId ? { id: fallbackId, label: fallbackLabel, durationMs: WEEK_MS, ...(resetsAt !== undefined ? { resetsAt } : {}) } : undefined;
	}
	const duration = number(raw.duration);
	const multiplier = raw.timeUnit === "TIME_UNIT_MINUTE" ? 1 : raw.timeUnit === "TIME_UNIT_HOUR" ? 60 : raw.timeUnit === "TIME_UNIT_DAY" ? 24 * 60 : raw.timeUnit === "TIME_UNIT_WEEK" ? 7 * 24 * 60 : undefined;
	if (duration === undefined || multiplier === undefined || duration <= 0) return undefined;
	const durationMs = duration * multiplier * 60_000;
	const resetsAt = timestamp(resetValue) ?? timestamp(raw.resetTime);
	return Number.isSafeInteger(durationMs) ? { id: `${fallbackId}:${duration * multiplier}m`, label: fallbackLabel, durationMs, ...(resetsAt !== undefined ? { resetsAt } : {}) } : undefined;
}

function kimiLimit(id: string, label: string, raw: unknown, window: SimpleUsageWindow | undefined, tier?: string): SimpleUsageLimit | undefined {
	if (!isRecord(raw) || !window) return undefined;
	const used = number(raw.used);
	const limit = number(raw.limit);
	if (used === undefined || limit === undefined || limit <= 0 || !Number.isSafeInteger(used) || !Number.isSafeInteger(limit)) return undefined;
	const amount = boundedAmount(used, limit, "unknown");
	return amount ? { id, label, scope: { windowId: window.id, shared: tier === undefined, ...(tier ? { tier } : {}) }, window, amount, status: usageStatus(amount.usedFraction ?? 0) } : undefined;
}

function kimiMoney(value: unknown): number | undefined {
	const raw = number(value);
	return raw === undefined || raw < 0 ? undefined : raw / 100_000_000;
}

async function fetchKimiUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiAuth(context, "kimi-coding", { origins: ["https://api.kimi.com"] });
	if (!auth) return undefined;
	const response = await fetchJson(fetchImpl, KIMI_USAGE_URL, bearerHeaders(auth), context.signal);
	if ("error" in response) {
		if (response.status === 429 || response.status === 402) return undefined;
		return failedReport("kimi-coding", response.error);
	}
	const payload = response.value;
	if (!isRecord(payload)) return failedReport("kimi-coding", "invalid usage payload");
	const limits: SimpleUsageLimit[] = [];
	const summaryWindow = kimiWindow(undefined, "weekly", "7 Day", isRecord(payload.usage) ? payload.usage.resetTime : undefined);
	const summary = kimiLimit("kimi-coding:weekly", "Total quota", payload.usage, summaryWindow);
	if (summary) limits.push(summary);
	if (Array.isArray(payload.limits)) {
		payload.limits.forEach((item, index) => {
			if (!isRecord(item)) return;
			const detail = isRecord(item.detail) ? item.detail : undefined;
			const window = kimiWindow(item.window, `detail-${index}`, text(item.name) ?? "Kimi plan window", detail?.resetTime);
			const minutes = window ? Math.round((window.durationMs ?? 0) / 60_000) : index;
			const limit = kimiLimit(`kimi-coding:detail:${minutes}:${index}`, text(item.name) ?? "Kimi plan window", detail, window, text(item.name));
			if (limit) limits.push(limit);
		});
	}
	const wallet = isRecord(payload.boosterWallet) && isRecord(payload.boosterWallet.balance) ? payload.boosterWallet : undefined;
	if (wallet) {
		const currency = text(isRecord(wallet.monthlyChargeLimit) ? wallet.monthlyChargeLimit.currency : undefined) ?? text(isRecord(wallet.monthlyUsed) ? wallet.monthlyUsed.currency : undefined) ?? "USD";
		const balance = kimiMoney(isRecord(wallet.balance) ? wallet.balance.amountLeft : undefined);
		if (balance !== undefined) limits.push({ id: "kimi-coding:wallet:balance", label: `Kimi extra balance (${currency})`, amount: { remaining: balance, unit: currency.toLowerCase() }, status: "ok" });
		const monthlyUsed = isRecord(wallet.monthlyUsed) ? number(wallet.monthlyUsed.priceInCents) : undefined;
		const monthlyLimit = isRecord(wallet.monthlyChargeLimit) ? number(wallet.monthlyChargeLimit.priceInCents) : undefined;
		if (monthlyUsed !== undefined) limits.push({ id: "kimi-coding:wallet:used", label: "Kimi extra used this month", amount: { used: monthlyUsed / 100, unit: currency.toLowerCase() }, status: "ok" });
		if (monthlyLimit !== undefined) limits.push({ id: "kimi-coding:wallet:limit", label: "Kimi extra monthly limit", amount: { limit: monthlyLimit / 100, unit: currency.toLowerCase() }, status: "ok" });
	}
	if (limits.length === 0) return failedReport("kimi-coding", "no recognized usage limits");
	const tokenIdentity = jwtPayload(auth.accessToken);
	const accountId = text(payload.accountId) ?? text(payload.userId) ?? text(tokenIdentity?.user_id) ?? text(tokenIdentity?.sub);
	return { provider: "kimi-coding", fetchedAt: Date.now(), limits, metadata: { authSource: "pi", ...(accountId ? { accountId } : {}) } };
}

async function fetchOpenRouterUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiAuth(context, "openrouter", { origins: ["https://openrouter.ai"] });
	if (!auth) return undefined;
	const headers = bearerHeaders(auth);
	const [keyResponse, creditsResponse] = await Promise.all([
		fetchJson(fetchImpl, OPENROUTER_KEY_URL, headers, context.signal),
		fetchJson(fetchImpl, OPENROUTER_CREDITS_URL, headers, context.signal),
	]);
	const data = "value" in keyResponse && isRecord(keyResponse.value) && isRecord(keyResponse.value.data) ? keyResponse.value.data : undefined;
	const creditsData = "value" in creditsResponse && isRecord(creditsResponse.value) && isRecord(creditsResponse.value.data) ? creditsResponse.value.data : undefined;
	const limits: SimpleUsageLimit[] = [];
	const totalCredits = creditsData ? number(creditsData.total_credits) : undefined;
	const totalUsage = creditsData ? number(creditsData.total_usage) : undefined;
	if (totalCredits !== undefined && totalUsage !== undefined) {
		const remaining = totalCredits - totalUsage;
		limits.push({
			id: "openrouter:credits",
			label: "OpenRouter credits",
			amount: { remaining: Math.max(0, remaining), unit: "usd" },
			status: remaining > 0 ? "ok" : "exhausted",
		});
	}
	if (data) {
		const cap = number(data.limit);
		if (cap !== undefined && cap > 0) {
			const remaining = number(data.limit_remaining);
			const used = remaining === undefined ? number(data.usage) : Math.max(0, cap - remaining);
			const amount = used === undefined ? { limit: cap, unit: "usd" } : boundedAmount(used, cap, "usd");
			if (amount) limits.push({ id: "openrouter:key-limit", label: "OpenRouter key limit", amount, window: { id: "key", label: "Key limit", ...(timestamp(data.limit_reset) !== undefined ? { resetsAt: timestamp(data.limit_reset) } : {}) }, status: usageStatus(amount.usedFraction ?? 0) });
		}
		for (const [field, label] of [["usage_daily", "OpenRouter today"], ["usage_weekly", "OpenRouter this week"], ["usage_monthly", "OpenRouter this month"], ["usage", "OpenRouter all-time"]] as const) {
			const value = number(data[field]);
			if (value !== undefined) limits.push({ id: `openrouter:usage:${field}`, label, amount: { used: value, unit: "usd" }, status: "ok" });
		}
	}
	if (limits.length === 0) return failedReport("openrouter", ("error" in keyResponse ? keyResponse.error : undefined) ?? ("error" in creditsResponse ? creditsResponse.error : undefined) ?? "no recognized usage limits");
	const keyLabel = text(data?.label);
	return { provider: "openrouter", fetchedAt: Date.now(), limits, metadata: { authSource: "pi", ...(keyLabel ? { keyLabel } : {}) } };
}

async function fetchDeepSeekUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiAuth(context, "deepseek", { origins: ["https://api.deepseek.com"] });
	if (!auth) return undefined;
	const response = await fetchJson(fetchImpl, DEEPSEEK_BALANCE_URL, bearerHeaders(auth), context.signal);
	if ("error" in response) return failedReport("deepseek", response.error);
	const payload = response.value;
	if (!isRecord(payload) || typeof payload.is_available !== "boolean" || !Array.isArray(payload.balance_infos)) return failedReport("deepseek", "invalid usage payload");
	const limits: SimpleUsageLimit[] = [];
	for (const item of payload.balance_infos) {
		if (!isRecord(item) || (item.currency !== "CNY" && item.currency !== "USD")) continue;
		const unit = item.currency === "USD" ? "usd" : "cny";
		for (const [field, label] of [["total_balance", "total"], ["granted_balance", "granted"], ["topped_up_balance", "topped-up"]] as const) {
			const value = number(item[field]);
			if (value !== undefined && value >= 0) limits.push({ id: `deepseek:${String(item.currency).toLowerCase()}:${field}`, label: `DeepSeek ${item.currency} ${label}`, amount: { remaining: value, unit }, status: payload.is_available ? "ok" : "warning" });
		}
	}
	if (limits.length === 0) return failedReport("deepseek", "no recognized usage limits");
	return { provider: "deepseek", fetchedAt: Date.now(), limits, metadata: { authSource: "pi", apiAvailable: payload.is_available } };
}

async function fetchOpenCodeUsage(context: PiAuthUsageContext, fetchImpl: PiUsageFetch): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiAuth(context, "opencode-go", { origins: ["https://opencode.ai"] });
	if (!auth) return undefined;
	const response = await fetchJson(fetchImpl, OPENCODE_USAGE_URL, bearerHeaders(auth), context.signal);
	if ("error" in response) return failedReport("opencode-go", response.error);
	const payload = response.value;
	const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : undefined;
	if (!usage) return failedReport("opencode-go", "invalid usage payload");
	const limits: SimpleUsageLimit[] = [];
	for (const [id, label, durationMs] of [["rolling", "OpenCode rolling", 5 * HOUR_MS], ["weekly", "OpenCode weekly", WEEK_MS], ["monthly", "OpenCode monthly", undefined]] as const) {
		const row = isRecord(usage[id]) ? usage[id] : undefined;
		const percent = row ? number(row.percent) : undefined;
		if (percent === undefined) continue;
		const amount = percentAmount(percent);
		const resetsAt = row ? timestamp(row.resetsAt) : undefined;
		limits.push({ id: `opencode-go:${id}`, label, scope: { windowId: id, shared: true }, window: { id, label, ...(durationMs ? { durationMs } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) }, amount, status: row?.status === "rate-limited" ? "exhausted" : usageStatus(amount.usedFraction ?? 0) });
	}
	if (limits.length === 0) return failedReport("opencode-go", "no recognized usage limits");
	return { provider: "opencode-go", fetchedAt: Date.now(), limits, metadata: { authSource: "pi" } };
}

/** Fetch usage only through verified provider endpoints with Pi-resolved credentials. */
export async function collectPiAuthUsageReports(
	context: PiAuthUsageContext,
	fetchImpl: PiUsageFetch = fetch,
	provider?: string,
): Promise<SimpleUsageReport[]> {
	const requested = normalizeUsageProvider(provider);
	const collectors: Array<[string, () => Promise<SimpleUsageReport | undefined>]> = [
		["anthropic", () => fetchClaudeUsage(context, fetchImpl)],
		["cursor", () => fetchCursorUsage(context, fetchImpl)],
		["deepseek", () => fetchDeepSeekUsage(context, fetchImpl)],
		["kimi-coding", () => fetchKimiUsage(context, fetchImpl)],
		["openai-codex", () => fetchCodexUsage(context, fetchImpl)],
		["openrouter", () => fetchOpenRouterUsage(context, fetchImpl)],
		["opencode-go", () => fetchOpenCodeUsage(context, fetchImpl)],
		["xai-oauth", () => fetchXaiUsage(context, fetchImpl)],
	];
	const selected = requested ? collectors.filter(([id]) => id === requested) : collectors;
	const reports = await Promise.all(
		selected.map(async ([id, collect]) => {
			try {
				return await collect();
			} catch (error) {
				return failedReport(id, safeUsageError(error));
			}
		}),
	);
	return reports.filter((report): report is SimpleUsageReport => Boolean(report));
}

/** Redact identifiers added by direct Pi-auth requests for `--redact`. */
export function redactPiAuthUsageReports(reports: readonly SimpleUsageReport[]): SimpleUsageReport[] {
	const mask = (value: unknown): unknown => {
		if (typeof value !== "string" || !value) return value;
		return value.length <= 2 ? "*" : `${value.slice(0, 2)}*`;
	};
	return reports.map(report => ({
		...report,
		metadata: report.metadata
			? {
				...report.metadata,
				email: mask(report.metadata.email),
				accountId: mask(report.metadata.accountId),
				orgId: mask(report.metadata.orgId),
				orgName: mask(report.metadata.orgName),
			}
			: report.metadata,
		limits: report.limits?.map(limit => ({
			...limit,
			scope: limit.scope
				? {
					...limit.scope,
					accountId: mask(limit.scope.accountId) as string | undefined,
					projectId: mask(limit.scope.projectId) as string | undefined,
					orgId: mask(limit.scope.orgId) as string | undefined,
				}
				: limit.scope,
		})),
	}));
}
