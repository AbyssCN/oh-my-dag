/** 夹具:碰了这一版宿主没实现的 API —— 必须在**加载期**被拒并逐条列出。 */
export default function register(api, ctx) {
  api.registerShortcut('ctrl+g', { handler: () => {} });
  void ctx.sessionManager;
  api.registerTool({ name: 'x', description: '', parameters: {}, execute: () => 'x' });
}
