import { expect, test } from "bun:test";
import { getUsageArgumentCompletions } from "../src/autocomplete.ts";

test("suggests the compact simple view", () => {
	const result = getUsageArgumentCompletions("");
	expect(result?.[0]).toMatchObject({
		value: "simple ",
		label: "simple",
	});
});

test("filters the compact view by typed prefix", () => {
	expect(getUsageArgumentCompletions("si")).toEqual([
		{
			value: "simple ",
			label: "simple",
			description: "Show compact provider usage and limits",
		},
	]);
});

test("completes provider ids after --provider", () => {
	const all = getUsageArgumentCompletions("--provider ");
	expect(all?.map(item => item.label)).toContain("anthropic");
	expect(all?.map(item => item.label)).toContain("google-gemini-cli");
	expect(all?.map(item => item.label)).toContain("zai");
	expect(all).toHaveLength(16);

	expect(getUsageArgumentCompletions("--provider open")).toEqual([
		{ value: "--provider openai-codex ", label: "openai-codex", description: "Only show usage for this provider" },
		{ value: "--provider opencode-go ", label: "opencode-go", description: "Only show usage for this provider" },
	]);
	expect(getUsageArgumentCompletions("--provider unknown-x")).toBeNull();
});
