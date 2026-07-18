/**
 * 叶执行注入接缝(INV-X1/X3):executor-dag 只认这些**接口形状**,不 import 任何执行实现。
 * 形状 = 私有上游 agent-leaf.ts / command-leaf.ts / model-router.ts 的公开契约原样
 * (provenance: 私有上游 worktree 时点)。
 * 实现方:宿主注入 pi-agent runner;或生产侧注入
 * omd-pi provider runner(随 provider slice)。测试注入 fake。
 */
import type { ModelUsage } from '../model/gateway';

// ── agent leaf(带工具的 pi session,能改文件)────────────────────────
export interface AgentLeafInput {
  /** 完整执行 prompt(已含 node 目标 + fan-in 上下文)。 */
  prompt: string;
  /** 'provider:modelId'。 */
  model: string;
}
export interface AgentLeafResult {
  text: string;
  usage: ModelUsage;
  /** 本次 leaf 经 write/edit 族工具触碰的文件(continuity 接缝;去重)。 */
  filesTouched?: string[];
}
/** 注入点:executor-dag 的 agent-kind 节点经此跑。 */
export type AgentLeafRunner = (input: AgentLeafInput) => Promise<AgentLeafResult>;

// ── command leaf(确定性 CLI,零 LLM)────────────────────────────────
export interface CommandLeafInput {
  /** 要跑的 CLI 命令串(conductor 产出,经闸+白名单校验)。 */
  command: string;
}
export interface CommandLeafResult {
  text: string;
  usage: ModelUsage;
  exitCode: number;
}
/** 注入点:executor-dag 的 command-kind 节点经此跑。 */
export type CommandLeafRunner = (input: CommandLeafInput) => Promise<CommandLeafResult>;

// ── leaf 模型路由(ε-greedy bandit;静态 fallback = no-op)──────────────
export interface LeafModelRouter {
  /** 给 bucket 选模型坐标;pool 空/单 → 返 fallback(no-op = 静态)。 */
  select(bucket: string, fallback: string, category?: string): string;
  /** 记一次 reward(∈[0,1])给 (bucket, model);pool ≤1 或 model ∉ pool → no-op。 */
  recordReward(bucket: string, model: string, reward: number): void;
}
