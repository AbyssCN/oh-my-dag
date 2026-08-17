// D1 gate 超时 fixture: before_agent_start 挂死 —— 宿主必须走声明默认 (放行原串)。
export default (api) => {
  api.on('before_agent_start', async (e) => {
    await new Promise((r) => setTimeout(r, 60_000));
    return { systemPrompt: `${e.systemPrompt}\n[太迟了不该出现]` };
  });
};
