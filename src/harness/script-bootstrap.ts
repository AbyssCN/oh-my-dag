/**
 * src/harness/script-bootstrap —— dag-*.ts **脚本入口副作用引导** (multi-project, script 路径)。
 *
 * 用法: DAG 驱动脚本 (dag-build/dag-research/…) **首行** `import '../src/harness/script-bootstrap';`。
 *
 * 解决的真问题: 用户在目标 repo 里 `cwd=该 repo` 直接调 dag 脚本时, 脚本默认把 `.omd/<...>`
 * 运行态写进**那个 repo**, 污染它的 git status。本引导:
 *   ① 默认 `OMD_DATA_HOME = ~/.omd` (未显式设时) → 运行态出 cwd repo。
 *   ② `setActiveProject(resolveProject())` → per-repo 工作态落 `~/.omd/projects/<slug>/`,
 *      全局学习/配额落 `~/.omd/global/` (见 project-scope dataPath / globalDataPath)。
 *
 * TUI (`omd` 交互入口) **不** import 本模块 → OMD_DATA_HOME 未设 → 退回 `.omd/` 旧路径
 * (零回归, 不孤儿化既有运行态数据)。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import '../env-alias';
import { resolveProject, setActiveProject } from './project-scope';

process.env.OMD_DATA_HOME ??= join(homedir(), '.omd');

try {
  setActiveProject(resolveProject());
} catch {
  // resolveProject 为 best-effort (非 git 退 basename), 实际不会抛; 仍兜底防御 —— 退回 .omd。
}
