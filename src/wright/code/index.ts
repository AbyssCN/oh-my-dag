/**
 * code barrel —— wright code mode (一回合多工具编排 + 数据密集活省 token)。
 */
export {
  createHttpToolBridge,
  buildPreamble,
  type ToolBridge,
  type ToolFn,
  type ToolMap,
} from './bridge';
export { runCodeMode, type RunCodeModeOpts } from './run';
export { createCodeExtension, type CodeExtensionOpts } from './code-extension';
