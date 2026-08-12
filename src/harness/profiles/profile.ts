/**
 * src/harness/profiles/profile —— LeafProfile 库:岗位档案 (profile) 的加载/合并/解析。
 *
 * 档案 = 装配一个 agent leaf 的岗位描述 (seat/persona/skills/tools/outputSchema/ledgerPath)。
 * 来源两层:内置 (src/harness/profiles/builtin/*.json, 随本模块走, cwd 无关) + 项目层
 * (.omd/profiles/*.json, 相对 cwd)。同名合并是**字段级**:项目层字段胜, 项目未写出的字段
 * 保留内置值 —— 整体覆盖会让项目少写一个可选字段就把内置值抹掉 (G-1 判的就是这个)。
 *
 * fail-open 纪律:坏 json 单文件跳过不炸整表, 但每个 catch 留一行证据 (文件名 + 错误原文),
 * 不许空 catch (对照 plan-ledger 的旧式空 catch, 这里按装配点要求升级)。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';

export interface ProfileSpec {
  name: string;
  seat?: string;
  persona?: string;
  skills?: string[];
  tools?: string[];
  outputSchema?: string;
  ledgerPath?: string;
  /** 前端文件 glob (设计审核用), 默认 **\/*.{tsx,jsx,css,html,vue,svelte}。 */
  frontendGlob?: string;
}

/** LeafProfile = ProfileSpec 的导出别名, 装配点按此名引用岗位档案类型。 */
export type LeafProfile = ProfileSpec;

/** 内置档案目录:目录现在可能不存在 (P4 才放首个条目) → 空集, 不报错。 */
const BUILTIN_DIR = join(import.meta.dir, 'builtin');

/**
 * 读一个目录的 *.json 档案。目录不存在 → 空集 (不报错)。
 * 坏文件跳过 + 留证据 (文件名 + 错误原文);缺 name/persona 的同样跳过留证据。
 * 同一层内重名 (两个文件同 name) → 后读到的胜 (readdirSync 顺序, 依赖方别这么写)。
 */
function readDirProfiles(dir: string, layer: string): Map<string, ProfileSpec> {
  const out = new Map<string, ProfileSpec>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const abs = join(dir, file);
    try {
      const raw = JSON.parse(readFileSync(abs, 'utf8')) as Partial<ProfileSpec>;
      if (typeof raw !== 'object' || raw === null || typeof raw.name !== 'string') {
        logger.warn({ file: abs, err: 'name 缺失或类型错' }, `profiles[${layer}]: 跳过非法档案`);
        continue;
      }
      out.set(raw.name, raw as ProfileSpec);
    } catch (err) {
      logger.warn({ file: abs, err: String(err) }, `profiles[${layer}]: 跳过损坏 json`);
    }
  }
  return out;
}

/** 内置 + 项目层 (.omd/profiles/*.json) 叠加。同名 → 字段级 merge, 项目层字段胜。每次现读。 */
export function loadProfiles(cwd: string): Map<string, ProfileSpec> {
  const merged = new Map<string, ProfileSpec>();
  for (const [name, spec] of readDirProfiles(BUILTIN_DIR, 'builtin')) merged.set(name, { ...spec });
  for (const [name, spec] of readDirProfiles(join(cwd, '.omd', 'profiles'), 'project')) {
    const base = merged.get(name);
    merged.set(name, base ? { ...base, ...spec } : { ...spec });
  }
  return merged;
}

/** 未知名 → undefined, 不抛 (闸在装配点)。 */
export function resolveProfile(name: string, cwd: string): ProfileSpec | undefined {
  return loadProfiles(cwd).get(name);
}
