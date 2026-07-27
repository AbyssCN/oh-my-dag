# MCP 生态 2026 年中盘点 — deep research 样例输出

> 这是 oh-my-dag deep research 的一份**真实样例输出**,不是文档正文。问题:「MCP(Model
> Context Protocol)生态 2026 年中盘点:spec 演进、安全事件与攻击面、客户端与服务端采用格局;
> 每个关键断言带来源 URL,区分一手来源与二手转述」。
>
> 两套系统跑的是同一道题(方法与读数见 [docs/deep-research.md](../deep-research.md) 的 A/B 对比)。
> 下面这份是 **System B**(Claude dynamic workflow)在对抗核查后合成的断言集:106 个 agent 抓取 →
> 断言抽取 → 每条 3 票对抗核查(2/3 反驳才杀)。收录的都是 **3-0 全票存活**的断言,按一手 / 二手
> 标注。System A(omd `--deep`)对同题产出了 132k 字终稿 + 全文语料附录,覆盖了下列断言的 13/15。

**统计**:34 个来源 · 22 个独立域名 · 3 个子题全覆盖 · 130 次对抗核查投票,0 条被反驳。

---

## 1 · Spec 演进(2026 上半年)

- **H1 2026 没有新的稳定版**;最新稳定版仍是 **2025-11-25**(MCP 一周年发布)。下一版 **2026-07-28**
  只是 **Release Candidate**,2026-05-21 锁定,预定 07-28 定稿,由 lead maintainer David Soria Parra
  与 Den Delimarsky 公布,称其为「协议发布以来最大的一次修订」。
  — 一手:`blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/` · `modelcontextprotocol.io/specification/draft/changelog`
- **无状态化(核心变化)**:移除 `initialize`/`initialized` 握手与 `Mcp-Session-Id` 头,每个请求在
  `_meta` 里自带协议版本 + 客户端能力(SEP-2575),版本不匹配返回 `UnsupportedProtocolVersionError`。
  服务器因此能挂在普通轮询负载均衡后**水平扩容**。跨调用状态改由**服务端签发的 handle 当普通工具参数**
  传递(SEP-2567)。 — 一手:draft changelog · The Register(二手交叉印证)
- **弃用三特性**:Roots / Sampling / Logging 进入新的特性生命周期政策,弃用窗口 ≥12 个月(SEP-2577 /
  SEP-2596);建议迁移:Roots→工具参数/资源 URI,Sampling→直连 LLM provider API,Logging→stderr/OpenTelemetry。
- **MRTR(Multi Round-Trip Requests)**:以 `InputRequiredResult` 重试流替代服务端发起请求
  (`roots/list`/`sampling/createMessage`/`elicitation/create`),所有结果新增必填 `resultType`(SEP-2322)。
- **扩展框架**:MCP Apps(沙箱 iframe 的服务端 UI,SEP-1865)与 Tasks(长任务,SEP-2663,从 2025-11-25
  的实验性核心特性外移为扩展)以 reverse-DNS 标识独立版本化;工具 `inputSchema`/`outputSchema` 升到完整
  **JSON Schema 2020-12**(支持 oneOf/anyOf/allOf、条件、引用)。
- **授权收紧**:弃用 OAuth 2.0 动态客户端注册(RFC 7591)改用 Client ID Metadata Documents(PR #2858);
  客户端**必须**按 RFC 9207 校验 `iss`(SEP-2468),凭据按 issuer 存不得跨授权服务器复用(SEP-2352)。
- **传输层**:2026 周期**不新增官方传输**,继续演进 Streamable HTTP(新增 `Mcp-Method`/`Mcp-Name` 路由头,
  让 LB 不看 body 就能路由);legacy HTTP+SSE 已在 2025-03-26 弃用。
- **SDK**:实现 RC 的 Beta TypeScript / Python SDK 于 2026-06-29 公布(Felix Weinberger / Max Isbey)。

## 2 · 安全事件与攻击面

**一手学术 / 权威研究**

- **NSA CSI**(U/OO/6030316-26,2026-06-02):《MCP: Security Design Considerations for AI-Driven
  Automation》。国家级安全机构为 MCP 出正式指导,本身是生态成熟度的锚点事件;认定**授权在 MCP 里是可选的 =
  协议级安全缺口**,并以 CVE-2025-49596 为真实案例。 — `media.defense.gov/2026/Jun/02/.../CSI_MCP_SECURITY.PDF`
- **Tool poisoning = 最主要的客户端攻击面**:恶意指令嵌在工具元数据里(间接 prompt injection)。实测七款
  主流客户端,多数因静态校验 / 参数可见性不足而存在问题(STRIDE + DREAD,跨五组件)。 — arXiv 2603.22489
- **MCP-38 威胁分类法**:38 类协议专属威胁(MCP-01…MCP-38),覆盖 tool poisoning / rug pull / confused
  deputy。 — arXiv 2603.18063(2026-03-18)
- **MCPSecBench**:17 种攻击向量,跨 Claude / OpenAI / Cursor 三平台每个攻击面都至少一次得手;**现有防御
  平均拦截成功率 <30%**。 — arXiv 2508.13220
- **MCP-Sec 大规模普查**:12,230 个工具 / 1,360 个服务器,**8.7% 工具可利用、27% 服务器**含风险能力。
- **Unicode TAG-block 隐匿**(2026-07):把 payload 编进无字形的 U+E0000–E007F,人眼在审批界面看不到;8/8
  技术成功注入,工具定义变更后**强制重新批准 0/8**——审批视图保真度缺口。 — arXiv 2607.05744

**真实事件 / CVE**

- **OX Security 供应链 advisory**:MCP STDIO 传输的不安全默认导致配置→命令的 RCE,设计层缺陷,波及
  **7,000+ 服务器 / 1.5 亿+ 下载**,横跨 Python/TS/Java/Rust SDK,归为 4 类漏洞族、14+ CVE;**Anthropic
  以「预期行为」拒绝改协议**。下游 CVE:CVE-2025-65720(GPT Researcher)、CVE-2026-30623(LiteLLM,已修)、
  CVE-2026-30624(Agent Zero)、CVE-2026-30617/30618(Langchain-Chatchat / Fay)。 — `ox.security` · `thehackernews.com`(二手)
- **CVE-2026-33032**:Nginx UI 缺失 MCP 认证,**CVSS 9.8**,默认 IP 白名单放行任意远端;2,600+ 实例暴露,
  **2026-04-13 已在野利用**(Recorded Future)——首批被实际利用的 MCP 端点漏洞之一。 — `rapid7.com`
- **CVE-2025-49596**:MCP Inspector(Anthropic 的测试工具)未认证 RCE,0.14.1 修复。
- **CVE-2025-6514**:mcp-remote OAuth 代理 OS 命令注入,**CVSS 9.6**,该包 437k+ 下载,恶意服务器经构造
  授权流触发。 — JFrog
- **供应链投毒**:SmartLoader 团伙三个月伪造开发者生态(五个 AI 人设 GitHub 账号交叉 fork),向合法
  registry 投放木马化 **Oura Ring MCP server**(StealC 窃密:浏览器密码 / 云会话 token / SSH key / 钱包),
  2026-02。 — `upguard.com`(二手汇编,事件具名可查)
- **Amazon Q VS Code 扩展**:CVSS 8.5,从工作区目录自动加载 MCP 配置无需同意,打开恶意仓库即执行代码并
  外泄 AWS 凭据(2026-06 修)。
- **GitHub MCP 数据窃取**(Invariant Labs,2025-05):公开 issue 里的间接 prompt injection 劫持 AI 助手外泄
  私有仓库内容。
- **机构化**:OWASP Agentic AI Top 10(ASI01–ASI10)于 2025-12 发布,把 MCP 事件演示的风险类别正式归档。

## 3 · 客户端与服务端采用格局

- **治理转折(硬事实)**:2025-12-09,Anthropic 把 MCP 捐给 Linux Foundation 旗下新设的 **Agentic AI
  Foundation(AAIF)**;共同发起 = Anthropic + OpenAI + Block;Platinum 成员 = AWS / Anthropic / Block /
  Bloomberg / Cloudflare / Google / Microsoft / OpenAI。**头号竞对 OpenAI 为 MCP 治理背书**,并贡献
  AGENTS.md。 — 一手:`linuxfoundation.org` · `anthropic.com` · `openai.com`
- **规模(2025-12 官方口径)**:10,000+ 活跃公开服务器,SDK **97M+ 次/月**下载。第三方聚合(PulseMCP /
  官方 registry / Smithery / mcp.so):~9,400 服务器(2026-04 中),较 2025 年底 ~6,800 增 ~38%;官方
  registry API 计数 9,652(2026-05-24)。
- **厂商侧(2026 H1 官方公告)**:
  - **Google Cloud Next '26**(2026-04):50+ Google 托管 MCP server GA/preview(BigQuery/Cloud Run/GKE/
    Spanner/Gmail/Drive…),称「每个 Google Cloud 服务默认 MCP 化」。 — `cloud.google.com`
  - **AWS MCP Server GA**(2026 H1):`call_aws` 单个工具经调用者 IAM 暴露 **15,000+ AWS API 操作**。 — `aws.amazon.com`
  - **Microsoft Copilot Studio**:MCP GA。 — `microsoft.com`
  - 客户端采用横跨主要竞品:Claude · Cursor · Microsoft Copilot · Gemini · VS Code · ChatGPT。
- **官方 Registry**:2025-09-08 preview 上线,H1 2026 仍为 preview(README 警告可能 breaking / 数据重置);
  单一上游真源 + 客户端市场 + 企业私有子注册表;发布强制命名空间归属校验(GitHub OAuth/OIDC + DNS + HTTP);
  持续迭代到 v1.8.0(2026-07-13)。 — `github.com/modelcontextprotocol/registry`
- **规模争议(校准面)**:社区审计称大量 server 为 fork / 弃维护(rapidclaw 抽样 1,847 个称 52% 已死、仅 17%
  达生产水准;DEV/Glama 指 2026 年生态重心从 server 转向 registry/gateway/auth「plumbing」层)。此为二手、
  未独立复核,与「万级 server」头条并列读。

---

## 附:System A(omd `--deep`)独有覆盖

同题 A 侧终稿另有 B 未点到的:**Censys 12,520 个暴露服务测量** · **Stacklok 企业调查 41% 生产采用** ·
**Anthropic 97M SDK 下载 / AAIF 捐赠的时间线归并**;而 A 漏了 B 有的两条:`Mcp-Method`/`Mcp-Name` 路由头
(RC 细粒度)与 CVE-2025-49596 的具体编号。两份并读覆盖面最全。
