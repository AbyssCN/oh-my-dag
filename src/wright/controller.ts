/**
 * WrightController —— wright 本体 (soul-as-code, SDD §4 V2 / §11.1, 候选 D71)。
 *
 * 灵魂硬编在它的字段里, 用 pi-coding-agent 当**库**驱动。多个薄前端都继承这一个灵魂:
 *   WrightController (灵魂=代码)  ──┬─ 终端 TUI  → pi main(args, { extensionFactories: ctrl.toExtensionFactories() })
 *    systemPrompt / hooks /        ├─ daemon     → PiRuntime({ controller }) → DefaultResourceLoader.extensionFactories
 *    tools / (memory V2-MEM)       └─ IM         → Lark/WeCom → controller (后续)
 *
 * V2.0 ControllerSkeleton: systemPrompt = WRIGHT_IDENTITY 常量 + provider/model + hooks/tools 空数组占位。
 * 其余子模块往字段上增量焊, 每步不破可用性:
 *   - V2-HOOK  → hooks  (8 原生 Pi 事件 handler)
 *   - V2-MEM   → memory (SQLite 两层)
 *   - V2-WEAK  → tools  (L1-L4 闸/grounding)
 *   - V2-ECON  → hooks  (before_provider_request 经济层)
 *   - V2-TOOLS → tools  (browser-harness + fan-out 原语)
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '../runtime/types';
import { WRIGHT_IDENTITY } from './identity';
import { createIdentityExtension } from './identity-extension';
import { createWrightHooks, type WrightHookConfig } from './hooks';
import type { WrightMemory } from './memory';
import { createGroundingNudgeExtension } from './weak';
import { wrapUserProfile } from './user-profile';
import { createIdentityExtension as createProfileExtension } from './identity-extension';

/**
 * **无硬默认模型** (the owner 2026-06-01 锁: 不 bake 任何 provider/model)。provider+model 必须经
 * config 或 env (XIHE_RUNTIME_PROVIDER/XIHE_RUNTIME_MODEL) 显式给 —— 缺则构造抛错。
 * 开源用户随意选 pi-ai 任一 provider; OUR 部署 (executor=DeepSeek / conductor=MiMo) 的选择落在
 * 部署入口 (tui.ts / cli.ts / dispatcher 注入), 不落库。thinking 仍可有非模型默认。
 */
const ENV_PROVIDER = 'XIHE_RUNTIME_PROVIDER';
const ENV_MODEL = 'XIHE_RUNTIME_MODEL';
const DEFAULT_THINKING: ThinkingLevel = 'medium';

export interface WrightControllerConfig {
  /** 灵魂 (意图层)。默认 WRIGHT_IDENTITY 常量。开源用户经此换自己的身份骨架。 */
  systemPrompt?: string;
  /** pi-ai provider id。默认 xiaomi-token-plan-ams, 或 XIHE_RUNTIME_PROVIDER。 */
  provider?: string;
  /** model id。默认 mimo-v2.5-pro, 或 XIHE_RUNTIME_MODEL。 */
  model?: string;
  /** thinking 档位。默认 medium。 */
  thinkingLevel?: ThinkingLevel;
  /** 项目级资源发现根 (skill/extension/context)。默认 process.cwd()。 */
  cwd?: string;
  /**
   * 意志层额外 extension 工厂 (灵魂注入 + wright runtime hook 由 controller 自动前置, 不在此)。
   * 给则 append 到默认 hooks 之后 (V2-ECON 等子模块经此挂自己的 handler)。
   */
  hooks?: ExtensionFactory[];
  /**
   * wright runtime 原生 hook 配置 (V2-HOOK)。默认挂 fail-closed tool-gate (dangerous-cmd)。
   * 设 `{ toolGate: null }` = 关闸 (null 逃生); 省略 = 默认安全闸。
   */
  hookConfig?: WrightHookConfig;
  /** 能力层占位 (V2-WEAK / V2-TOOLS 填; pi 自带 read/bash/edit/write 不在此)。 */
  tools?: readonly unknown[];
  /**
   * Tier-1 自我记忆 (V2-MEM, SDD §7)。给则 controller 拥有一个 SQLite 自我记忆
   * 体 (facts + hybrid 检索 + temporal KG); 省略 = 无持久记忆 (TUI 单次 / 测试)。
   * Tier-2 domain 记忆经 HostAdapter 注入, 不在 controller 字段。
   */
  memory?: WrightMemory;
  /**
   * 通用抗幻觉 grounding 软提示 (法定数字必带源, GROUNDING_NUDGE)。默认 **true** —— model-agnostic
   * (任何模型记忆都可能 stale), 所有前端默认挂。设 false 关 (纯代码 session 省 token)。
   * 注: 这是 grounding 的软半边; 真护栏是 L2 硬闸 (checkProseGrounding + 数字-对-源校验)。
   */
  groundingNudge?: boolean;
  /**
   * 用户静态档案内容 (user.md, 由部署入口读文件传入 — controller 保持纯, 不自己读盘)。给则在身份后、
   * grounding 前整段注入 ("wright 是谁" → "用户是谁" → "抗幻觉")。省略 = 无静态档案 (靠 user.* 动态学)。
   */
  userProfile?: string;
}

/**
 * wright 灵魂的代码载体。不可变字段 = 一个 controller 实例 = 一套确定的灵魂/能力配置。
 */
export class WrightController {
  /** 意图层: 系统提示灵魂 (冻结前缀)。 */
  readonly systemPrompt: string;
  /** baked executor provider。 */
  readonly provider: string;
  /** baked executor model。 */
  readonly model: string;
  /** thinking 档位。 */
  readonly thinkingLevel: ThinkingLevel;
  /** 资源发现根。 */
  readonly cwd: string;
  /** 意志层: wright runtime 原生 hook (默认 fail-closed tool-gate) + 用户额外 hooks。灵魂注入不在此, 见 toExtensionFactories。 */
  readonly hooks: readonly ExtensionFactory[];
  /** 能力层占位。 */
  readonly tools: readonly unknown[];
  /** Tier-1 自我记忆 (V2-MEM)。undefined = 无持久记忆。 */
  readonly memory?: WrightMemory;
  /** 通用抗幻觉 grounding 软提示是否注入。默认 true (universal)。 */
  readonly groundingNudge: boolean;
  /** 用户静态档案内容 (user.md)。undefined = 无。 */
  readonly userProfile?: string;

  constructor(config: WrightControllerConfig = {}) {
    this.systemPrompt = config.systemPrompt ?? WRIGHT_IDENTITY;
    const provider = config.provider ?? process.env[ENV_PROVIDER];
    const model = config.model ?? process.env[ENV_MODEL];
    if (!provider || !model) {
      throw new Error(
        `WrightController: provider/model 无硬默认 (the owner 锁) — 必须显式给 config.{provider,model} ` +
          `或设 env ${ENV_PROVIDER}/${ENV_MODEL}。pi-ai provider 任选 (deepseek / xiaomi-token-plan-ams / anthropic …), 不 bake。`,
      );
    }
    this.provider = provider;
    this.model = model;
    this.thinkingLevel = config.thinkingLevel ?? DEFAULT_THINKING;
    this.cwd = config.cwd ?? process.cwd();
    // wright 自有 runtime hook (默认 fail-closed tool-gate) 在前, 用户额外 hooks 在后。
    this.hooks = [...createWrightHooks(config.hookConfig), ...(config.hooks ?? [])];
    this.tools = config.tools ?? [];
    this.memory = config.memory;
    this.groundingNudge = config.groundingNudge ?? true;
    this.userProfile = config.userProfile;
  }

  /**
   * 灵魂注入 extension (恒前置) + runtime hooks → 喂给 pi main / DefaultResourceLoader 的 extensionFactories。
   * 所有前端共用这一个列表 = 同一套灵魂 + 同一套 fail-closed 闸 (VAL-INV-11)。
   */
  toExtensionFactories(): ExtensionFactory[] {
    return [
      createIdentityExtension(this.systemPrompt),
      // 用户静态档案 (user.md) 排在身份后: "wright 是谁" → "用户是谁"。给则注入。
      ...(this.userProfile ? [createProfileExtension(wrapUserProfile(this.userProfile))] : []),
      // 通用抗幻觉 grounding 软提示 (model-agnostic, 默认挂)。
      ...(this.groundingNudge ? [createGroundingNudgeExtension()] : []),
      ...this.hooks,
    ];
  }

  /** pi main() 的 `--provider X --model Y` 透传参数 (baked executor)。 */
  toModelArgs(): string[] {
    return ['--provider', this.provider, '--model', this.model];
  }
}
