---
name: omd-video
description: 视频→逐段结构化笔记 (MiMo-v2.5 原生吃画面+音频, 非 whisper 转写; 可重入管线)。讲解/课程视频里 PPT 框架图/代码/提示词是画面独有、音频拿不到的信息。产 ALL-NOTES.md 交 /omd-council 或 dag_research 做综合。Trigger:/omd-video、抖音/B站/YouTube 讲解视频、课程系列、把这些视频学一遍/提炼、画面里有代码/图表/PPT。Skip:文字原文综合→/omd-council;网页内容→dag_research(检索版)。
---

# /omd-video — 视频→逐段结构化笔记 (MiMo 多模态)

> 讲解类视频画面有大量 PPT/框架图/提示词/代码 = 音频拿不到 → MiMo-v2.5 **原生吃视频**(画面+音频),非 whisper 转写。确定性五阶段管线,**可重入**(已产出阶段自动跳过):discover/enumerate→download→segment→fanout→aggregate。综合/蒸馏不在本管线内——产物 `ALL-NOTES.md` 交给 omd dag 引擎。

## 何时用
抖音/B站/YouTube 讲解视频或课程系列要提炼成知识;画面信息密集(代码/图表/PPT)、音频拿不全的内容采集。

## 何时不用(边界)
已有**文字**原文要多视角综合 → `/omd-council`;要 web 页面内容/多源事实 → `dag_research`;要设计判优 → `/omd-council`。本管线只做"视频→笔记语料",综合让 dag 引擎做。

## 入口:先定用途,再定参数(跑之前必做)

视频采集是**一次性昂贵操作**(下载+切段+N 段并发喂模型),fps/分辨率选错 = 糊了读不到 或 烧钱重跑。所以拿到 url/描述后**先判用途再定参数**——能从用户描述/URL 推断就推断,并**宣告选定参数**再跑;只有画面构成不明(它决定 fps/res,猜错最贵)才问一句。**不逐参数确认(反 ceremonial),一次问清用途即可。**

三个要素定全部参数:① 画面构成(定 fps + media_resolution)② 要提取什么(定制 prompt)③ 时长量级(分段 + 成本预警)。

| 画面构成 | `--fps` | `--media-resolution` | `--scale` | prompt 侧重 |
|---|---|---|---|---|
| 纯口播/访谈/播客 | 1(可 0.5) | default(无字·省钱) | 640 | 口播要点 |
| PPT 幻灯讲解 | 1 | max | 960 | 屏幕文字+框架图 |
| 代码演示/live coding | 2 | max | 1280 | 逐行转录代码 |
| 动画/逐步 build/白板 | 2 | max | 960 | 抓状态变化时序 |
| UI 操作/点选演示 | 2–3 | max | 960 | 操作步骤序列 |

「要提取什么」和 fps 正交,单独定制 fanout prompt(只要提示词模板 / 只要代码 / 完整转录 → `--prompt-file` 或改 DEFAULT_PROMPT)。**画面构成不明时问一句**:「画面主要是啥——纯人讲 / PPT / 敲代码 / 动画演示?重点抓口播还是画面里的代码/提示词?」用户答完 → 宣告选定 fps/res/scale/prompt → 跑。

## 怎么跑
脚本自包含在本技能目录,随 omd mcp 自装到 `~/.claude/skills/omd-video/run.py`。用绝对路径调(尊重 `CLAUDE_CONFIG_DIR`):

```bash
SKILL="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/omd-video/run.py"

# 已有 url/id 列表 (每行 <url> 或 <id>|<slug>)
python "$SKILL" --urls list.txt --workdir /tmp/<job>

# 没链接只有题目: 平台搜索找片 (yt-dlp ytsearch 默认 / bilisearchN: B站; 抖音搜索不支持)
python "$SKILL" --search "<题目>" --max 6 --workdir /tmp/<job>

# 从抖音用户主页全自动枚举 (enumerate 阶段需 browser-harness 接管真 Chrome 登录态)
python "$SKILL" --enumerate "https://www.douyin.com/user/<sec_uid>" --workdir /tmp/<job>

# 单跑/补跑某阶段 (可重入)
python "$SKILL" --workdir /tmp/<job> --only fanout
```

**env**:`MIMO_API_KEY` 必需(os.environ 优先,否则找 `CWD/.env` 或 `~/.omd/.env`);`MIMO_BASE_URL` 默认 `https://api.xiaomimimo.com/v1`。**依赖**:`yt-dlp`、`ffmpeg`/`ffprobe` 在 PATH 内。

## 阶段与产物 (落 workdir)
| 阶段 | 干什么 | 产物 |
|---|---|---|
| discover | `--search` yt-dlp 平台搜索找片 | `urls.txt` |
| enumerate | browser-harness 滚主页抓全部作品 | `urls.txt` |
| download | yt-dlp 批量下 (钉死真 .mp4,ffprobe 校验) | `vids/*.mp4` |
| segment | ffmpeg 逐段精确切 + 强制段首关键帧 | `seg/*__NN.mp4` |
| fanout | N 段并发喂 mimo-v2.5,每段产笔记 | `notes/*.note.md` |
| aggregate | 按集聚合 | `episode-notes/*.md` + `ALL-NOTES.md` |

## 采样精度调参 (MiMo 原生采样层)
`run.py` 显式对齐 MiMo 的 fps/media_resolution,别用 API 默认值坑自己:
- **`--fps`(默认 1)** = 本地抽帧率 = 帧数上限,也作为 API 采样率发过去(两层对齐,否则本地多转的帧被 API 默认 2fps 截断)。纯口播留 1;**画面有翻页/逐步 build 动画升 2**(时序 grid 内两帧相隔 0.5s,接得住转场;fps>2 才涨时间戳 token,一般没必要)。
- **`--media-resolution`(默认 max)** = 按送进去的分辨率读画面文字。`default` 档每帧封顶 ~300 token≈739px,会把 960×540 压糊、读不清密集代码 → 本管线读文字故默认 `max`;纯口播省钱可切 `default`。
- **`--scale`(默认 960)** 视频宽,配 `max` 才真正生效;极密代码可临时 1280。

## 关键坑 (已在脚本内根除,勿回退)
- **段切 IDR**:必须逐段从原集 `-ss` 精确切 + `-force_key_frames`,不用 segment muxer——否则非关键帧切断致后续段无 IDR,mimo 报 `Multimodal corrupted`。
- **假 .mp4**:yt-dlp 不限 format 常落 webm 命名成 .mp4 → 下游 `glob('*.mp4')` 全空 → 笔记空。脚本钉 `--remux-video mp4` + ffprobe 校验视频流。
- **超长视频帧上限**:API 单请求帧数上限 2048(时长×fps 触顶后截断);170s@1fps 段远低于此,靠**分段**规避,别一整集高 fps 直灌。

## 下一步:综合交 omd dag (本管线之外)
跑完读 `ALL-NOTES.md`,再交 omd 引擎综合——skill 产语料,dag 做综合:
- **`/omd-council`** — 以你的聚焦为 goal 多视角判优(反中庸,挖非显然洞察);
- **`dag_research`** — 多源综合(视频笔记作 anchors)。
