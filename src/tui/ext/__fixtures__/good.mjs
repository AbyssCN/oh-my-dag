/** 夹具:一个合规扩展。**我们自己写的**,不是第三方代码。 */
export default function register(api) {
  api.registerTool({
    name: 'fixture_echo',
    description: 'echo back',
    promptSnippet: 'fixture_echo(text)',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: (_id, params) => `echo: ${params.text}`,
  });
  api.on('before_agent_start', (e) => ({ systemPrompt: `${e.systemPrompt}\n[fixture 追加]` }));
}
