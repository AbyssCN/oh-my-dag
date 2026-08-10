/**
 * src/harness/goal/sdd-direct —— solve 直通入口的 SDD 装载件 (SDD 2026-08-10-solve-sdd-direct-entry)。
 *
 * 已结晶的 SDD 即契约: `sddPath` 给了就跳过 research 轮与契约段子图 (specPath/evidence 直接
 * 取自文件, 与闸 C「契约段产物复用」同一条消费通路)。实测背景: 对一份 8KB 的已结晶 SDD,
 * 契约段转录税 ~224.5k tokens / ~15 分钟 (run b4989a06), 产出自述「GWT 逐条收录, 语义未改」。
 *
 * **fail-loud 是这里的全部性格** (D-3): 缺契约段的文档不是 SDD —— 拒起跑, 不静默降级回全程
 * goal (静默降级 = 调用方以为省了税, 实际付了全价, 比不支持更坏)。
 */
import { readFileSync } from 'node:fs';

/** 直通契约的最小结构要求: 六段式里这两段是执行与验收的地基, 缺任一 = 不是可执行契约。 */
const REQUIRED_SECTIONS: readonly { key: string; pattern: RegExp }[] = [
  { key: '契约 (Contracts)', pattern: /^##\s*契约|^##\s*Contracts/m },
  { key: '分解 (Breakdown)', pattern: /^##\s*分解|^##\s*Breakdown/m },
];

export interface SddContract {
  /** SDD 原文 (原样进 execute 任务文本, 含并行波形)。 */
  readonly text: string;
  /** 装载路径 (= specPath, 契约已落盘的那份就是它)。 */
  readonly path: string;
}

/**
 * 装载并校验直通 SDD。读不到 / 缺必备段 → throw (错误信息指名缺什么, G-2)。
 * 校验是结构级不是语义级: 段在就行, GWT 写没写好由 execute 的验收面兜 —— 这里挡的是
 * 「拿一篇散文冒充契约」那一档。
 */
export function loadSddContract(path: string): SddContract {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`sddPath 读不到: ${path} — ${(e as Error).message}`);
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !s.pattern.test(text)).map((s) => s.key);
  if (missing.length) {
    throw new Error(
      `sddPath 不是可执行契约 (缺段: ${missing.join('、')}): ${path} — ` +
        '缺契约段的文档回 /omd-contract 补齐, 不静默降级回全程 goal。',
    );
  }
  return { text, path };
}
