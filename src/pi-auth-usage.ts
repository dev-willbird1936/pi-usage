import { Buffer } from "node:buffer";
import type { SimpleUsageAmount, SimpleUsageLimit, SimpleUsageReport, SimpleUsageWindow } from "./simple-usage.ts";

/** Minimal Pi context needed to resolve Pi-managed OAuth credentials. */
export interface PiAuthUsageContext {
	modelRegistry?: {
		getProviderAuth(provider: string): Promise<
			| {
					auth?: { apiKey?: string };
					source?: string;
				}
			| undefined
		>;
	};
	signal?: AbortSignal;
}

export type PiUsageFetch = typeof fetch;

type PiOAuthAuth = { accessToken: string };
type PercentBucket = { utilization?: number; resetsAt?: number };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const REQUEST_TIMEOUT_MS = 20_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_MONTHLY_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";

/** Providers whose usage requests are always authenticated by Pi. */
export const PI_AUTH_USAGE_PROVIDER_IDS = ["anthropic", "xai-oauth"] as const;

export function isPiAuthUsageProvider(provider: string | undefined): boolean {
	const normalized = provider?.toLowerCase();
	return normalized === "anthropic" || normalized === "xai" || normalized === "xai-oauth";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000;
	if (typeof value !== "string" || !value.trim()) return undefined;
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

async function fetchJson(
	fetchImpl: PiUsageFetch,
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<unknown | undefined> {
	try {
		const response = await fetchImpl(url, {
			headers,
			redirect: "error",
			signal: requestSignal(signal),
		});
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	}
}

/** Resolve an OAuth access token from Pi, never from OMP's credential store. */
async function resolvePiOAuth(context: PiAuthUsageContext, provider: string): Promise<PiOAuthAuth | undefined> {
	try {
		const resolved = await context.modelRegistry?.getProviderAuth(provider);
		if (!resolved || !/oauth/i.test(resolved.source ?? "")) return undefined;
		const accessToken = text(resolved.auth?.apiKey);
		return accessToken ? { accessToken } : undefined;
	} catch {
		return undefined;
	}
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

async function fetchClaudeUsage(
	context: PiAuthUsageContext,
	fetchImpl: PiUsageFetch,
): Promise<SimpleUsageReport | undefined> {
	const auth = await resolvePiOAuth(context, "anthropic");
	if (!auth) return undefined;
	const headers = {
		accept: "application/json, text/plain, */*",
		"anthropic-beta":
			"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
		"user-agent": "claude-cli/2.1.220 (external, cli)",
		authorization: `Bearer ${auth.accessToken}`,
	};
	const [usagePayload, profilePayload] = await Promise.all([
		fetchJson(fetchImpl, CLAUDE_USAGE_URL, headers, context.signal),
		fetchJson(fetchImpl, CLAUDE_PROFILE_URL, headers, context.signal),
	]);
	if (!isRecord(usagePayload)) return undefined;

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
	if (limits.length === 0) return undefined;

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
		metadata: {
			authSource: "pi",
			...(identity.accountId ? { accountId: identity.accountId } : {}),
			...(identity.email ? { email: identity.email } : {}),
			...(identity.orgId ? { orgId: identity.orgId } : {}),
			...(identity.orgName ? { orgName: identity.orgName } : {}),
		},
	};
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
	const auth = await resolvePiOAuth(context, "xai");
	if (!auth) return undefined;
	const headers = {
		Authorization: `Bearer ${auth.accessToken}`,
		Accept: "application/json",
		"X-XAI-Token-Auth": "xai-grok-cli",
	};
	const [weeklyPayload, identityPayload] = await Promise.all([
		fetchJson(fetchImpl, XAI_BILLING_URL, headers, context.signal),
		fetchJson(fetchImpl, XAI_USERINFO_URL, { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" }, context.signal),
	]);
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
		weeklyConfig &&
		!(inferredWeeklyPercent && weeklyConfig.isUnifiedBillingUser === true)
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
		const monthlyPayload = await fetchJson(fetchImpl, XAI_MONTHLY_BILLING_URL, headers, context.signal);
		const monthlyConfig = isRecord(monthlyPayload) && isRecord(monthlyPayload.config) ? monthlyPayload.config : undefined;
		const monthlyWindow = monthlyConfig ? xaiWindow(monthlyConfig.billingPeriodStart, monthlyConfig.billingPeriodEnd, "1mo", "Monthly") : undefined;
		const used = monthlyConfig ? xaiAmount(monthlyConfig.used) : undefined;
		const limit = monthlyConfig ? xaiAmount(monthlyConfig.monthlyLimit) : undefined;
		const amount = used !== undefined && limit !== undefined ? boundedAmount(used, limit, "unknown") : undefined;
		if (monthlyWindow && amount) {
			limits.push({ id: "xai-oauth:included:1mo", label: "SuperGrok Monthly Included", scope: { windowId: monthlyWindow.id, shared: true, ...(accountId ? { accountId } : {}) }, window: monthlyWindow, amount, status: usageStatus(amount.usedFraction ?? 0) });
		}
	}
	if (limits.length === 0) return undefined;
	return {
		provider: "xai-oauth",
		fetchedAt: Date.now(),
		limits,
		metadata: { authSource: "pi", ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) },
	};
}

/** Fetch Claude and Grok usage with Pi's resolved OAuth credentials. */
export async function collectPiAuthUsageReports(
	context: PiAuthUsageContext,
	fetchImpl: PiUsageFetch = fetch,
	provider?: string,
): Promise<SimpleUsageReport[]> {
	const requested = provider?.toLowerCase();
	const collectors: Array<[string, () => Promise<SimpleUsageReport | undefined>]> = [
		["anthropic", () => fetchClaudeUsage(context, fetchImpl)],
		["xai-oauth", () => fetchXaiUsage(context, fetchImpl)],
	];
	const selected = requested ? collectors.filter(([id]) => id === requested) : collectors;
	const reports = await Promise.all(selected.map(([, collect]) => collect().catch(() => undefined)));
	return reports.filter((report): report is SimpleUsageReport => Boolean(report));
}

/** Prefer Pi-auth reports over OMP reports for Pi-auth-supported providers. */
export function mergePiAuthUsageReports(
	ompReports: readonly SimpleUsageReport[],
	piReports: readonly SimpleUsageReport[],
): SimpleUsageReport[] {
	const piAuthProviders = new Set<string>(PI_AUTH_USAGE_PROVIDER_IDS);
	const reportedProviders = new Set(piReports.map(report => report.provider.toLowerCase()));
	return [
		...ompReports.filter(report => {
			const provider = report.provider.toLowerCase();
			return !piAuthProviders.has(provider) && !reportedProviders.has(provider);
		}),
		...piReports,
	];
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
