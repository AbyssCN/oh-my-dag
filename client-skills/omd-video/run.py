#!/usr/bin/env python3
"""omd-video (run.py) — 原生多模态视频采集 → 逐段结构化笔记 (可复用, 自包含)。

后端: 默认 agy (Antigravity CLI 的 Gemini, 订阅额度, view_file 原生读 mp4); --backend mimo 走 MiMo API。

讲解类视频画面有大量 PPT 框架图/提示词/代码 = 音频拿不到的信息 → 用 MiMo-v2.5 原生吃视频
(画面+音频),而非 whisper 转写。本脚本把"抖音/通用视频 → 逐段结构化笔记"固化为确定性、
可重入的管线,产物 ALL-NOTES.md 交给 omd dag 工具 (/omd-council · dag_research) 做综合/蒸馏。

阶段 (默认全跑, 可 --only 单跑; 已产出的步骤自动跳过 = 可重入):
  discover   (可选) --search 平台搜索找片 (yt-dlp ytsearch/bilisearch) → urls.txt (抖音搜索不支持)
  enumerate  (可选) browser-harness 接管真 Chrome 滚动用户主页, 抓全部作品 id+标题 → urls.txt
  download   yt-dlp 批量下载 (抖音主页 yt-dlp 不支持枚举, 故 enumerate 单列)
  segment    ffmpeg 逐段**从原集精确切** (-ss/-t + 强制关键帧; 不用 segment muxer →
             根除"非关键帧切断致后续段无 IDR → mimo 报 Multimodal corrupted"的坑)
  fanout     N 段并发喂 mimo-v2.5 (video_url data-URL + 对齐原生采样层的 fps/media_resolution),
             每段产结构化笔记
  aggregate  按集 (slug 去 __NN) 聚合逐段笔记 → episode-notes/<slug>.notes.md + ALL-NOTES.md

综合/蒸馏 (本管线之外, omd-native): ALL-NOTES.md 喂给 /omd-council (多视角判优) 或
  dag_research (多源综合) —— skill 产语料, dag 引擎做综合, 不在此脚本内重造蒸馏。

用法:
  # 从用户主页全自动 (需 browser-harness = 真实 Chrome 登录态)
  python run.py --enumerate "https://www.douyin.com/user/<sec_uid>" --workdir /tmp/job

  # 已有 id/url 列表 (每行: <url> 或 <id>|<slug>)
  python run.py --urls list.txt --workdir /tmp/job

  # 没链接只有题目 (YouTube/B站 平台搜索找片)
  python run.py --search "claude code agent harness" --max 6 --workdir /tmp/job
  python run.py --search "bilisearch8:复式记账 原理" --workdir /tmp/job

  # 单跑某阶段 (调试/补跑)
  python run.py --workdir /tmp/job --only fanout

env: agy 后端无 key (用 agy 自己的登录); mimo 后端要 MIMO_API_KEY / MIMO_BASE_URL
(os.environ 优先, 否则找 CWD/.env 或 ~/.omd/.env)。
依赖: yt-dlp, ffmpeg/ffprobe, agy (PATH 内); 仅标准库 (urllib)。
"""
import argparse
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BH = os.path.expanduser("~/.claude/skills/browser-harness/bh.sh")

DEFAULT_PROMPT = (
    "你在分析一个教学/讲解视频的一个片段(约 3 分钟,连续课程的一段)。"
    "请忠实输出该片段的结构化笔记(中文),不要概括成空话,保留所有具体内容:\n"
    "## 口播要点\n讲了什么道理/方法/经验(分点)。\n"
    "## 屏幕文字与图示\n逐条转录屏幕上出现的标题/列表/框架图/表格/代码/提示词模板/工具名"
    "(这是画面独有、音频没有的信息,最重要)。\n"
    "## 可操作方法\n该片段给出的具体规则/步骤/检查清单/提示词(如有,原样保留)。\n"
    "若片段无实质内容(片头/片尾/广告)写'(无实质内容)'。"
)


# ── env ──────────────────────────────────────────────────────────────
def load_env(key, default=None):
    """os.environ 优先, 再按标准位置找 .env (CWD/.env → ~/.omd/.env)。
    自包含 skill 不假设 repo 布局: 脚本被铺到 ~/.claude/skills/ 下, 身边没有仓库 .env。"""
    if os.environ.get(key):
        return os.environ[key]
    for env_path in (os.path.join(os.getcwd(), ".env"), os.path.expanduser("~/.omd/.env")):
        if os.path.exists(env_path):
            for line in open(env_path):
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


# ── enumerate (browser-harness 滚动主页) ──────────────────────────────
def stage_enumerate(user_url, urls_file):
    if os.path.exists(urls_file) and os.path.getsize(urls_file) > 10:
        print(f"[enumerate] {urls_file} 已存在, 跳过")
        return
    if not os.path.exists(BH):
        sys.exit(f"[enumerate] 找不到 browser-harness ({BH})。请手动准备 --urls 列表 "
                 f"(每行 <url> 或 <id>|<slug>)。")
    py = f'''
import time, json
new_tab("{user_url}")
time.sleep(8)
seen = {{}}
def harvest():
    out = js(\"\"\"JSON.stringify(Array.from(document.querySelectorAll('a[href*="/video/"]')).map(a => ({{
      id: (a.href.match(/video\\\\/(\\\\d+)/)||[])[1],
      t: (a.innerText||'').replace(/\\\\s+/g,' ').trim().slice(0,90)}})))\"\"\")
    for it in json.loads(out):
        if it['id'] and (it['id'] not in seen or len(it['t']) > len(seen[it['id']])):
            seen[it['id']] = it['t']
js("window.scrollTo(0,0)"); time.sleep(2)
stale = 0
for i in range(40):
    harvest(); js("window.scrollBy(0, 700)"); time.sleep(1.6)
    before = len(seen); harvest()
    if len(seen) == before:
        stale += 1
        if stale >= 6: break
    else: stale = 0
print("HARVEST_JSON:" + json.dumps(seen, ensure_ascii=False))
'''
    r = subprocess.run([BH], input=py, capture_output=True, text=True, timeout=300)
    m = re.search(r"HARVEST_JSON:(\{.*\})", r.stdout)
    if not m:
        sys.exit(f"[enumerate] 滚动采集失败。stdout尾:\n{r.stdout[-500:]}\nstderr:\n{r.stderr[-300:]}")
    items = json.loads(m.group(1))
    with open(urls_file, "w") as f:
        for vid, title in items.items():
            slug = slugify(title)
            f.write(f"https://www.douyin.com/video/{vid}|{slug}\n")
    print(f"[enumerate] {len(items)} 作品 → {urls_file} (请人工审一遍, 删非目标作品/改 slug)")


def slugify(title):
    t = re.sub(r"[#@].*$", "", title)
    t = re.sub(r"[^\w一-鿿]+", "-", t).strip("-")
    return t[:40] or "video"


# ── discover (yt-dlp 平台搜索 → urls.txt; 接"只有题目没链接"的入口) ────
def stage_discover(search, max_n, urls_file):
    """支持 yt-dlp 搜索表达式 (ytsearchN:/bilisearchN:...); 裸查询默认 ytsearch<max_n>:。
    抖音搜索 yt-dlp 不支持 → 走 --enumerate (browser-harness) 或手动 urls.txt。"""
    if os.path.exists(urls_file):
        print(f"[discover] {urls_file} 已存在, 跳过 (可重入; 要重搜先删它)")
        return
    expr = search if re.match(r"^[a-z]+search\d*:", search) else f"ytsearch{max_n}:{search}"
    print(f"[discover] yt-dlp 搜索: {expr}")
    r = subprocess.run(
        ["yt-dlp", "--flat-playlist", "--print", "%(url)s|%(title)s", expr],
        capture_output=True, text=True, timeout=180)
    lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    if r.returncode != 0 or not lines:
        sys.exit(f"[discover] 搜索失败/零结果: {r.stderr[-200:]}\n"
                 f"(抖音搜索 yt-dlp 不支持 → --enumerate 或手动 urls.txt)")
    with open(urls_file, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[discover] {len(lines)} 条 → {urls_file} (建议人工审一遍再 download)")


# ── download ─────────────────────────────────────────────────────────
def stage_download(urls_file, vid_dir):
    os.makedirs(vid_dir, exist_ok=True)
    if not os.path.exists(urls_file):
        sys.exit(f"[download] 缺 {urls_file} (先 --enumerate 或手动准备)")
    jobs = []
    for i, line in enumerate(open(urls_file)):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            url, slug = line.split("|", 1)
        else:
            url, slug = line, f"{i:02d}-video"
        url = url.strip()
        if "/" not in url and url.isdigit():
            url = f"https://www.douyin.com/video/{url}"
        out = os.path.join(vid_dir, f"{i:02d}-{slugify(slug)}.mp4")
        if not os.path.exists(out):
            jobs.append((url, out))
    print(f"[download] {len(jobs)} 待下载")

    def dl(job):
        url, out = job
        # 钉死真 .mp4 容器 (坑根除): 不限定 format 时 yt-dlp 常落 webm/vp9, 但 `-o ....mp4`
        # 只决定文件名 → 实际写成 `xxx.mp4.webm`, 下游 glob('*.mp4') 全空 → 笔记空.
        #   -S res:720,vcodec:h264 : 优先 ≤720p + h264 (足够读 PPT/代码且利于段切), 缺则优雅回退
        #   --merge-output-format / --remux-video mp4 : 无损只换容器, 保证产物确为 .mp4
        r = subprocess.run([
            "yt-dlp", "-q", "--no-playlist",
            "-S", "res:720,vcodec:h264,acodec:aac",
            "--merge-output-format", "mp4", "--remux-video", "mp4",
            "-o", out, url], capture_output=True, text=True, timeout=900)
        # yt-dlp 可能把成品落成 out 的兄弟名 (扩展名不符时); 兜底找回并归一到 out
        if not os.path.exists(out):
            stem = os.path.splitext(out)[0]
            cands = [p for p in glob.glob(stem + ".*") if os.path.getsize(p) > 1_000_000]
            if cands:
                os.replace(max(cands, key=os.path.getsize), out)
        # 真伪校验: 必须是 ffprobe 读得到视频流的文件 (挡住 webm-命名-mp4 这类坑回归)
        ok = (r.returncode == 0 and os.path.exists(out)
              and b"video" in subprocess.run(
                  ["ffprobe", "-v", "error", "-select_streams", "v",
                   "-show_entries", "stream=codec_type", "-of", "csv=p=0", out],
                  capture_output=True).stdout)
        return (out, ok, r.stderr[-200:])

    with ThreadPoolExecutor(max_workers=3) as ex:
        for out, ok, err in ex.map(dl, jobs):
            print(f"  {'ok' if ok else 'FAIL'}: {os.path.basename(out)}{'' if ok else ' '+err}")


# ── segment (逐段从原集精确切, 根除 IDR 坑) ───────────────────────────
def ffprobe_dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def stage_segment(vid_dir, seg_dir, seg_len, scale, fps):
    # 为何必须转码 (而非"mimo 能直接看 mp4 就原样喂"): mimo 按送进去的帧采样, base64 要上传整段 →
    # 原片 30fps × 68min 单请求会爆/天价. 转码做三件事: ① 抽到 fps (讲解视频 1 帧/秒够) 砍帧数;
    # ② scale 降分辨率控 base64 体积 (但太低读不清代码/PPT, 故默认 960 不是 360);
    # ③ -ss 后置精确切 + 强制段首关键帧 → 每段独立可解, 根除 "Multimodal corrupted".
    # 注: 本地 fps = 帧数上限, 但 API 真正采样率/时序 token 由 fanout 里的 api_fps 决定, 两者须对齐.
    os.makedirs(seg_dir, exist_ok=True)
    vids = sorted(glob.glob(os.path.join(vid_dir, "*.mp4")))
    if not vids:
        sys.exit(f"✗ [segment] {vid_dir} 无 *.mp4 — download 阶段未产出可读视频. "
                 f"不继续 (否则 fanout/aggregate 全空). 查 download 日志.")
    print(f"[segment] {len(vids)} 集, 段长 {seg_len}s @ {scale}px/{fps}fps")
    tasks = []
    for v in vids:
        base = os.path.splitext(os.path.basename(v))[0]
        dur = ffprobe_dur(v)
        n = max(1, int((dur + seg_len - 1) // seg_len))
        for idx in range(n):
            start = idx * seg_len
            if dur - start < 3:  # 末段 <3s = 片尾, 跳
                continue
            out = os.path.join(seg_dir, f"{base}__{idx:02d}.mp4")
            if not os.path.exists(out):
                tasks.append((v, start, seg_len, out, scale, fps))

    def cut(t):
        v, start, length, out, scale, fps = t
        # -ss 在 -i 后 = 精确 seek; 重编码 + 强制关键帧开头 → 每段独立可解 (无 IDR 坑)
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-i", v, "-ss", str(start), "-t", str(length),
            "-vf", f"scale={scale}:-2", "-r", str(fps), "-g", str(fps * 5),
            "-force_key_frames", "expr:gte(t,0)", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "30", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", out],
            capture_output=True, timeout=600)
        return os.path.basename(out)

    with ThreadPoolExecutor(max_workers=4) as ex:
        for i, _name in enumerate(ex.map(cut, tasks)):
            if (i + 1) % 10 == 0:
                print(f"  cut {i+1}/{len(tasks)}")
    print(f"[segment] {len(glob.glob(os.path.join(seg_dir, '*.mp4')))} 段")


# ── fanout (mimo-v2.5 多模态) ─────────────────────────────────────────
def stage_fanout(seg_dir, note_dir, prompt, workers, max_tokens, model, key, base, api_fps, media_resolution):
    os.makedirs(note_dir, exist_ok=True)
    segs = sorted(glob.glob(os.path.join(seg_dir, "*.mp4")))
    print(f"[fanout] {len(segs)} 段 → {model} (并发 {workers}, api_fps={api_fps}, res={media_resolution})")

    def call(seg):
        note = os.path.join(note_dir, os.path.basename(seg).replace(".mp4", ".note.md"))
        if os.path.exists(note) and os.path.getsize(note) > 60:
            return ("skip", seg)
        b64 = base64.b64encode(open(seg, "rb").read()).decode()
        # fps/media_resolution 必须显式发 (对齐 MiMo 原生采样层, 否则用 API 默认值):
        #  · fps: 不发 → API 默认 2fps 采样, 会截断本地 --fps>2 转出的帧 (白转码) 且 timestamp
        #    token 精度 (>2 给5/grid 否则3/grid) 由此值定, 非本地 ffmpeg fps → 必须等于本地降采样率.
        #  · media_resolution: 不发 → default 档每帧封顶 300 token≈307200px, 把 960×540 硬压到
        #    ~739px, 读代码/PPT 的初衷被架空 → 本管线读画面文字, 默认 max 保清晰.
        payload = {"model": model, "max_tokens": max_tokens, "temperature": 0.3,
                   "messages": [{"role": "user", "content": [
                       {"type": "video_url", "video_url": {"url": "data:video/mp4;base64," + b64},
                        "fps": api_fps, "media_resolution": media_resolution},
                       {"type": "text", "text": prompt}]}]}
        for attempt in range(3):
            try:
                req = urllib.request.Request(base + "/chat/completions",
                    data=json.dumps(payload).encode(),
                    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                r = json.load(urllib.request.urlopen(req, timeout=300))
                content = r["choices"][0]["message"].get("content") or ""
                if content.strip():
                    open(note, "w").write(content)
                    return ("ok", seg)
                return ("empty", seg)
            except Exception as e:
                body = getattr(e, "read", lambda: b"")()
                if attempt == 2:
                    return (f"err:{str(e)[:50]}{body[:80]}", seg)
                time.sleep(3 * (attempt + 1))

    ok = done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for f in as_completed([ex.submit(call, s) for s in segs]):
            status, seg = f.result() or ("err:none", "?")
            done += 1
            if status == "ok":
                ok += 1
            elif not status.startswith("skip"):
                print(f"  [{done}/{len(segs)}] {status}  {os.path.basename(seg)}")
    print(f"[fanout] {ok} 新增 ok / {len(segs)} 段 (失败段: 多为非关键帧切断, 重跑 segment 阶段再 fanout)")


# ── fanout (agy = Antigravity CLI, Google 订阅通道的 Gemini) ─────────────
# 2026-10-02 实测 (agy 1.1.28, gemini-3.8-flash-high, 170s 段): Gemini 经 agy 的 view_file 工具原生读 mp4
# (画面 + 音轨), 单段 ~11s / ~44K 输入 token; 屏幕上的 settings.json/docstring 逐字转出, 口播引语与 whisper
# 转写近乎逐字。没有 fps/media_resolution 旋钮 —— 采样由 Gemini 自定, 本地 --fps 只决定转码帧数。
# 两个实测坑:
#  · `--output-format json` 偶发 response 只有 "{truncated:true}" → 用 stream-json, result 坏了就拼 text_delta;
#  · 模型会想跑 ffmpeg 之类命令, headless 下被拒后可能空答 → prompt 钉死「只用 view_file」,
#    且不给 --dangerously-skip-permissions (--mode plan 只读)。
AGY_PREAMBLE = (
    "Use ONLY your file viewing tool on the video file {path} (it has video frames and an audio track; "
    "the viewer reads video natively). Do NOT run any shell command. "
    "Never transcribe secret values (API keys, tokens, passwords): write <redacted> in their place. "
    "If the viewer cannot give you the frames or the audio, reply exactly CANNOT_READ_VIDEO.\n\n"
)


def agy_response(stdout):
    """从 stream-json 取最终回答。result.response 坏 (空 / "{truncated:true}") 时, 拼最后一个
    agent_response 步的 text_delta。"""
    result, deltas, last_step = None, {}, None
    for line in stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("event") == "result":
            result = e.get("result") or {}
        su = e.get("step_update") or {}
        if su.get("step_type") == "agent_response" and "text_delta" in su:
            deltas.setdefault(su.get("step_index"), []).append(su["text_delta"])
            last_step = su.get("step_index")
    text = (result or {}).get("response") or ""
    if text.strip() in ("", "{truncated:true}") and last_step is not None:
        text = "".join(deltas[last_step])
    return text


def agy_refused(text):
    """Gemini 安全过滤的拒答也是一段 >60 字的文本 —— 不认出来就会被当笔记写进磁盘 (2026-10-02 实测
    一段讲 Jev 的 Claude Code 演示被拦 3 次, 同段同 prompt 单独再跑又过)。偶发 → 当失败重试。"""
    return "blocked by Gemini's filters" in text or "CANNOT_READ_VIDEO" in text


def stage_fanout_agy(seg_dir, note_dir, prompt, workers, model):
    os.makedirs(note_dir, exist_ok=True)
    segs = sorted(glob.glob(os.path.join(seg_dir, "*.mp4")))
    print(f"[fanout] {len(segs)} 段 → agy {model} (并发 {workers})")

    def call(seg):
        note = os.path.join(note_dir, os.path.basename(seg).replace(".mp4", ".note.md"))
        if (os.path.exists(note) and os.path.getsize(note) > 60
                and not agy_refused(open(note).read())):  # 旧拒答当缺笔记重跑
            return ("skip", seg)
        seg_abs = os.path.abspath(seg)
        full = AGY_PREAMBLE.format(path=seg_abs) + prompt
        err = ""
        for attempt in range(3):
            try:
                r = subprocess.run(
                    ["agy", "--output-format", "stream-json", "--model", model, "--mode", "plan",
                     "-p=" + full],  # -p= 必须等号连写 (agy-cli-complete.ts 实测坑)
                    cwd=os.path.dirname(seg_abs), capture_output=True, text=True, timeout=600)
                text = agy_response(r.stdout)
                if agy_refused(text):  # 过滤拒答与 CANNOT_READ_VIDEO 实测都是偶发, 同段重跑会过
                    err = "拒答: " + text.strip()[:40]
                elif len(text.strip()) > 60:
                    open(note, "w").write(text)
                    return ("ok", seg)
                else:
                    err = f"exit={r.returncode} empty; stderr={r.stderr.strip()[-120:]}"
            except subprocess.TimeoutExpired:
                err = "timeout 600s"
            time.sleep(5 * (attempt + 1))
        return (f"err:{err}", seg)

    ok = done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for f in as_completed([ex.submit(call, s) for s in segs]):
            status, seg = f.result()
            done += 1
            if status == "ok":
                ok += 1
            elif status != "skip":
                print(f"  [{done}/{len(segs)}] {status}  {os.path.basename(seg)}")
    print(f"[fanout] {ok} 新增 ok / {len(segs)} 段")


# ── aggregate ────────────────────────────────────────────────────────
def stage_aggregate(note_dir, ep_dir, all_notes):
    os.makedirs(ep_dir, exist_ok=True)
    notes = sorted(glob.glob(os.path.join(note_dir, "*.note.md")))
    by_ep = {}
    for n in notes:
        ep = re.sub(r"__\d+\.note\.md$", "", os.path.basename(n))
        by_ep.setdefault(ep, []).append(n)
    for ep, parts in sorted(by_ep.items()):
        out = [f"# {ep}\n"]
        for p in sorted(parts):
            idx = re.search(r"__(\d+)", p)
            out.append(f"\n--- 段 {idx.group(1) if idx else '?'} ---\n")
            body = open(p).read().strip()
            # 拒答文本不当笔记聚合; 留显式缺口, 不让一段静默消失 (§静默坑 2)
            out.append("(本段无笔记: 模型拒答, 重跑 --only fanout)" if agy_refused(body) else body)
        open(os.path.join(ep_dir, ep + ".notes.md"), "w").write("\n".join(out))
    with open(all_notes, "w") as f:
        for ep in sorted(by_ep):
            f.write(open(os.path.join(ep_dir, ep + ".notes.md")).read() + "\n")
    print(f"[aggregate] {len(by_ep)} 集 → {ep_dir} + {all_notes}")


# ── main ─────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="MiMo 多模态视频采集→逐段结构化笔记 (综合交 omd dag)")
    ap.add_argument("--workdir", required=True, help="工作目录 (各阶段产物落此, 可重入)")
    ap.add_argument("--enumerate", metavar="USER_URL", help="browser-harness 滚动用户主页抓全集")
    ap.add_argument("--search", metavar="QUERY", help="平台搜索找片 (ytsearch/bilisearch 表达式或裸查询=ytsearch; 抖音不支持)")
    ap.add_argument("--max", type=int, default=8, help="--search 裸查询取前 N (默认 8)")
    ap.add_argument("--urls", help="视频列表文件 (每行 <url> 或 <id>|<slug>); 缺省用 workdir/urls.txt")
    ap.add_argument("--only", choices=["discover", "enumerate", "download", "segment", "fanout", "aggregate"],
                    help="只跑某阶段")
    ap.add_argument("--seg-len", type=int, default=170, help="段长秒 (默认 170)")
    ap.add_argument("--scale", type=int, default=960, help="视频宽 px (默认 960 ≈ 540p, 够读 PPT/代码; 体积敏感可降 640)")
    ap.add_argument("--fps", type=int, default=1, help="本地抽帧率 = 帧数上限 (讲解视频 1 够; PPT 动画/翻页多可升 2; 默认 1)")
    ap.add_argument("--media-resolution", choices=["default", "max"], default="max",
                    help="MiMo 单帧解析档: max=按送进去的分辨率读(读代码/PPT 必须, 默认); "
                         "default=每帧封顶~300token≈739px(省钱但小字会糊)")
    ap.add_argument("--backend", choices=["agy", "mimo"], default="agy",
                    help="fanout 后端: agy=Antigravity CLI 的 Gemini (默认, 订阅额度); mimo=MiMo API (按量)")
    ap.add_argument("--workers", type=int, help="fanout 并发 (默认 agy 3 / mimo 8)")
    ap.add_argument("--max-tokens", type=int, default=4000, help="仅 mimo")
    ap.add_argument("--model", help="多模态模型 (默认 agy: gemini-3.8-flash-high / mimo: mimo-v2.5)")
    ap.add_argument("--prompt-file", help="自定义 fanout prompt 文件 (覆盖默认教学视频 prompt)")
    args = ap.parse_args()

    wd = args.workdir
    os.makedirs(wd, exist_ok=True)
    urls_file = args.urls or os.path.join(wd, "urls.txt")
    vid_dir, seg_dir, note_dir = os.path.join(wd, "vids"), os.path.join(wd, "seg"), os.path.join(wd, "notes")
    ep_dir, all_notes = os.path.join(wd, "episode-notes"), os.path.join(wd, "ALL-NOTES.md")
    prompt = open(args.prompt_file).read() if args.prompt_file else DEFAULT_PROMPT

    needs_model = args.only in (None, "fanout")
    key = base = None
    if args.backend == "mimo":
        key = load_env("MIMO_API_KEY")
        base = load_env("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1")
        if not key and needs_model:
            sys.exit("缺 MIMO_API_KEY (env 或 CWD/.env 或 ~/.omd/.env)")
    elif needs_model and not shutil.which("agy"):
        sys.exit("agy 不在 PATH (Antigravity CLI; 或改 --backend mimo)")
    model = args.model or ("gemini-3.8-flash-high" if args.backend == "agy" else "mimo-v2.5")
    workers = args.workers or (3 if args.backend == "agy" else 8)

    run = (lambda s: args.only == s) if args.only else (lambda _s: True)

    if (args.search and not args.only) or run("discover"):
        if args.search:
            stage_discover(args.search, args.max, urls_file)
    if (args.enumerate and not args.only) or run("enumerate"):
        if args.enumerate:
            stage_enumerate(args.enumerate, urls_file)
    if run("download"):
        stage_download(urls_file, vid_dir)
    if run("segment"):
        stage_segment(vid_dir, seg_dir, args.seg_len, args.scale, args.fps)
    if run("fanout"):
        if args.backend == "agy":
            stage_fanout_agy(seg_dir, note_dir, prompt, workers, model)
        else:
            stage_fanout(seg_dir, note_dir, prompt, workers, args.max_tokens, model, key, base,
                         args.fps, args.media_resolution)
    if run("aggregate"):
        stage_aggregate(note_dir, ep_dir, all_notes)

    sz = os.path.getsize(all_notes) if os.path.exists(all_notes) else 0
    print("✅ done")
    if sz > 200:
        print(f"   聚合料 → {all_notes} ({sz//1024}KB)")
        print(f"   综合/蒸馏 (omd-native, 本脚本不做): 读 {all_notes} 后交 omd dag —")
        print(f"     /omd-council  以 '<你的聚焦>' 为 goal 多视角判优")
        print(f"     或 dag_research  多源综合 (把笔记作 anchors)")


if __name__ == "__main__":
    main()
