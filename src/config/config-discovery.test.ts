/**
 * Tests for config-discovery (D-20 auto-probe + channel declaration builder).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	discoverProviders,
	classifyPlan,
	buildChannelDeclarations,
	discoverChannels,
	readDeclaredPlans,
	PLAN_STRINGS,
} from "./config-discovery";

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omd-discovery-"));
	env = { PI_AGENT_DIR: dir };
});

afterEach(() => {
	// Cleanup is implicit: tmpdir gets cleaned by OS.
});

describe("readDeclaredPlans (D-20 声明持仓)", () => {
	function writeConfig(content: unknown): string {
		const p = join(dir, "config.json");
		writeFileSync(p, JSON.stringify(content));
		return p;
	}

	it("读 declaredPlans 段, 跳过坏条目 (fail-open)", () => {
		const p = writeConfig({
			declaredPlans: [
				{ provider: "kimi-coding", kind: "token", plan: "allegretto" },
				{ provider: "opencode-go", kind: "flat" }, // 无 plan → 'declared'
				{ provider: "", kind: "token" }, // 空 provider → 跳过
				{ provider: "x", kind: "bogus" }, // 非法 kind → 跳过
				"not-an-object", // → 跳过
			],
		});
		const out = readDeclaredPlans(env, p);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ provider: "kimi-coding", kind: "token", plan: "allegretto" });
		expect(out[1]).toMatchObject({ provider: "opencode-go", kind: "flat", plan: "declared" });
	});

	it("文件缺 / 无 declaredPlans 段 → []", () => {
		expect(readDeclaredPlans(env, join(dir, "nope.json"))).toEqual([]);
		expect(readDeclaredPlans(env, writeConfig({ version: 2 }))).toEqual([]);
	});

	it("discoverChannels 合并声明持仓 (auto-probe 探不到的也进渠道, 声明胜)", () => {
		env.DEEPSEEK_API_KEY = "sk-x"; // auto-probe 到 deepseek
		const cfg = writeConfig({
			declaredPlans: [{ provider: "kimi-coding", kind: "token", plan: "allegretto" }],
		});
		const { declarations } = discoverChannels(env, { configPath: cfg });
		const providers = declarations.map((d) => d.provider);
		expect(providers).toContain("deepseek"); // auto
		expect(providers).toContain("kimi-coding"); // declared (auth.json 探不到, 声明补上)
	});
});

describe("discoverProviders", () => {
	it("picks up DEEPSEEK_API_KEY from env", () => {
		env.DEEPSEEK_API_KEY = "sk-deepseek-test";
		const r = discoverProviders(env);
		expect(r.some((p) => p.id === "deepseek" && p.source === "env")).toBe(true);
	});

	it("picks up MIMO_API_KEY + ZHIPU_API_KEY", () => {
		env.MIMO_API_KEY = "sk-mimo";
		env.ZHIPU_API_KEY = "sk-zhipu";
		const r = discoverProviders(env);
		const ids = r.map((p) => p.id);
		expect(ids).toContain("mimo");
		expect(ids).toContain("zhipu");
	});

	it("picks up OAuth from auth.json", () => {
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				providers: {
					"kimi-coding": {
						oauth: {
							access: "tok_abc123",
							refresh: "ref_xyz",
							expires: 9999999999999,
						},
					},
				},
			}),
		);
		const r = discoverProviders(env, { authPath });
		const kimi = r.find((p) => p.id === "kimi-coding");
		expect(kimi).toBeDefined();
		expect(kimi!.source).toBe("auth.json");
		expect(kimi!.isOAuth).toBe(true);
	});

	it("picks up api_key from auth.json", () => {
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				providers: {
					"kimi-coding": { api_key: "sk-kimi-direct" },
				},
			}),
		);
		const r = discoverProviders(env, { authPath });
		const kimi = r.find((p) => p.id === "kimi-coding");
		expect(kimi).toBeDefined();
		expect(kimi!.isOAuth).toBe(false);
	});

	it("picks up custom providers from models.json", () => {
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					zhipu: {
						baseUrl: "https://open.bigmodel.cn/api/paas/v4",
						apiKey: "sk-zhipu-literal",
						api: "openai-completions",
						models: [{ id: "glm-5.2" }],
					},
				},
			}),
		);
		const r = discoverProviders(env, { modelsPath });
		const zhipu = r.find((p) => p.id === "zhipu");
		expect(zhipu).toBeDefined();
		expect(zhipu!.source).toBe("models.json");
	});

	it("resolves $ENV references in models.json apiKey", () => {
		env.ZHIPU_API_KEY = "sk-zhipu-from-env";
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					zhipu: {
						baseUrl: "https://open.bigmodel.cn/api/paas/v4",
						apiKey: "$ZHIPU_API_KEY",
						api: "openai-completions",
						models: [{ id: "glm-5.2" }],
					},
				},
			}),
		);
		const r = discoverProviders(env, { modelsPath });
		const zhipu = r.find((p) => p.id === "zhipu");
		expect(zhipu).toBeDefined();
		expect(zhipu!.hasKey).toBe(true);
	});

	it("skips models.json entry with missing $ENV key", () => {
		// No ZHIPU_API_KEY in env
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					zhipu: {
						baseUrl: "https://open.bigmodel.cn/api/paas/v4",
						apiKey: "$ZHIPU_API_KEY",
						api: "openai-completions",
						models: [{ id: "glm-5.2" }],
					},
				},
			}),
		);
		const r = discoverProviders(env, { modelsPath });
		expect(r.some((p) => p.id === "zhipu")).toBe(false);
	});

	it("picks up OPENCODE_API_KEY as Go subscription", () => {
		env.OPENCODE_API_KEY = "oc-key-123";
		const r = discoverProviders(env);
		const go = r.find((p) => p.id === "opencode-go");
		expect(go).toBeDefined();
		expect(go!.source).toBe("go-subscription");
	});

	it("deduplicates: env → auth → models → go, last-write-wins", () => {
		env.DEEPSEEK_API_KEY = "sk-env";
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				providers: {
					deepseek: { api_key: "sk-auth" },
				},
			}),
		);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					deepseek: {
						baseUrl: "https://api.deepseek.com",
						apiKey: "sk-models",
						api: "openai-completions",
						models: [{ id: "deepseek-v4-pro" }],
					},
				},
			}),
		);
		const r = discoverProviders(env, { authPath, modelsPath });
		const ds = r.filter((p) => p.id === "deepseek");
		// Should be exactly 1 (deduped), from models.json (last source).
		expect(ds).toHaveLength(1);
		expect(ds[0]!.source).toBe("models.json");
	});

	it("handles missing auth.json gracefully", () => {
		const r = discoverProviders(env, { authPath: "/nonexistent/auth.json" });
		expect(r).toBeArrayOfSize(0);
	});

	it("handles corrupted JSON gracefully", () => {
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, "NOT JSON{{{");
		const r = discoverProviders(env, { authPath });
		expect(r).toBeArrayOfSize(0);
	});

	it("returns sorted by id", () => {
		env.ZHIPU_API_KEY = "sk-z";
		env.DEEPSEEK_API_KEY = "sk-d";
		env.MIMO_API_KEY = "sk-m";
		const r = discoverProviders(env);
		const ids = r.map((p) => p.id);
		expect(ids).toEqual([...ids].sort());
	});
});

describe("classifyPlan", () => {
	it("Go subscription → go", () => {
		expect(
			classifyPlan({
				id: "opencode-go",
				source: "go-subscription",
				hasKey: true,
				isOAuth: false,
			}),
		).toBe("go");
	});

	it("OAuth provider → pay-per-use", () => {
		expect(
			classifyPlan({
				id: "kimi-coding",
				source: "auth.json",
				hasKey: true,
				isOAuth: true,
			}),
		).toBe("pay-per-use");
	});

	it("env key → unknown (needs manual classification)", () => {
		expect(
			classifyPlan({
				id: "deepseek",
				source: "env",
				hasKey: true,
				isOAuth: false,
			}),
		).toBe("unknown");
	});
});

describe("buildChannelDeclarations", () => {
	it("builds DeclaredPlan[] from classifications", () => {
		const discovered = [
			{ id: "deepseek", source: "env" as const, hasKey: true, isOAuth: false },
			{
				id: "opencode-go",
				source: "go-subscription" as const,
				hasKey: true,
				isOAuth: false,
			},
		];
		const plans = new Map([
			["deepseek", "pay-per-use" as const],
			["opencode-go", "go" as const],
		]);
		const r = buildChannelDeclarations(plans, discovered);
		expect(r).toHaveLength(2);
		const ds = r.find((d) => d.provider === "deepseek")!;
		expect(ds.kind).toBe("token");
		expect(ds.plan).toBe("pay-per-use");
		const go = r.find((d) => d.provider === "opencode-go")!;
		expect(go.kind).toBe("flat");
		expect(go.plan).toBe("go");
	});

	it("uses auto-classify when plan not in map", () => {
		const discovered = [
			{
				id: "kimi-coding",
				source: "auth.json" as const,
				hasKey: true,
				isOAuth: true,
			},
		];
		const r = buildChannelDeclarations(new Map(), discovered);
		expect(r).toHaveLength(1);
		expect(r[0]!.plan).toBe("pay-per-use");
	});

	it("deduplicates by provider id", () => {
		const discovered = [
			{ id: "deepseek", source: "env" as const, hasKey: true, isOAuth: false },
			{
				id: "deepseek",
				source: "models.json" as const,
				hasKey: true,
				isOAuth: false,
			},
		];
		const r = buildChannelDeclarations(new Map(), discovered);
		expect(r).toHaveLength(1);
	});
});

describe("discoverChannels (full pipeline)", () => {
	it("probes all sources and builds declarations", () => {
		env.DEEPSEEK_API_KEY = "sk-ds";
		env.MIMO_API_KEY = "sk-mimo";
		env.OPENCODE_API_KEY = "sk-go";
		const { discovered, declarations } = discoverChannels(env);
		expect(discovered.length).toBeGreaterThanOrEqual(3);
		expect(declarations.length).toBeGreaterThanOrEqual(3);
		// Go should be flat kind.
		const goDecl = declarations.find((d) => d.provider === "opencode-go");
		expect(goDecl).toBeDefined();
		expect(goDecl!.kind).toBe("flat");
	});

	it("applies planOverrides", () => {
		env.DEEPSEEK_API_KEY = "sk-ds";
		const { declarations } = discoverChannels(env, {
			planOverrides: { deepseek: "prepaid" },
		});
		const ds = declarations.find((d) => d.provider === "deepseek");
		expect(ds).toBeDefined();
		expect(ds!.plan).toBe("prepaid");
	});

	it("returns empty when no credentials found", () => {
		const { discovered, declarations } = discoverChannels({});
		expect(discovered).toHaveLength(0);
		expect(declarations).toHaveLength(0);
	});
});
