import { expect, test } from "bun:test";
import { getUsageArgumentCompletions } from "../src/autocomplete.ts";

test("suggests expanded usage modes", () => {
	const result = getUsageArgumentCompletions("");
	expect(result?.[0]).toMatchObject({
		value: "current ",
		label: "current",
	});
});

test("does not autocomplete the removed simple mode", () => {
	expect(getUsageArgumentCompletions("si")).toBeNull();
});

test("completes provider ids after --provider", () => {
	const all = getUsageArgumentCompletions("--provider ");
	expect(all?.map(item => item.label)).toEqual([
		"anthropic",
		"cursor",
		"deepseek",
		"kimi-coding",
		"openai-codex",
		"openrouter",
		"opencode-go",
		"xai-oauth",
	]);
	expect(getUsageArgumentCompletions("--provider unknown-x")).toBeNull();
});
