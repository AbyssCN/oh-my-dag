#!/usr/bin/env python3
"""
scripts/claude-token-auto —— `claude setup-token` 的通用自动化配方 (python3 stdlib, 零依赖)。

人只做两个动作: ① 浏览器点一次 Authorize ② 把回调页的 code 粘贴回来。其余全自动:
起 setup-token 拿住 pty → 打印授权 URL → 等你贴 code → 喂回 → 提取 token → 干净环境验真 → 写 env。

    python3 scripts/claude-token-auto.py [--env-file .env] [--no-verify]

五条实战教训焊死在此 (2026-07-22 五轮排障, 见 memory pathfinder-issues-architecture):
  1. pty 宽度必须在子进程 exec **前**设 (400 列) —— 否则 TUI 按 80 列折行渲染 token,
     流里只能刮到渲染碎片 (真 oat01 = 108 字符, 曾抓出 79/130 的废品)。
  2. TUI 开 kitty 增强键盘协议, 裸 \\r 不被当 Enter —— 喂 code 后补发 ESC[13u。
  3. 提取只在**单行内**匹配, 不跨行拼接 (拼接会把相邻渲染文字粘进 token)。
  4. 验真必须隔离 HOME —— 否则 claude CLI 优先用 ~/.claude/.credentials.json 自身登录态,
     产生假阳性 (token 是废的也报成功)。
  5. 每次 setup-token 会吊销前一枚 token —— 本脚本一次跑完不重入; 失败重跑即重新授权。
"""
import argparse
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
from typing import NoReturn

AUTH_URL_RE = re.compile(r"https://claude\.com/cai/oauth/authorize\S+")
# oat01 token: 单行完整匹配 (教训 3); 长度下限挡渲染残段。
TOKEN_RE = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]{40,}")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)")
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{30,}#[A-Za-z0-9_-]{10,}$")


def die(msg: str) -> NoReturn:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def mask(tok: str) -> str:
    return tok[:16] + "…" + tok[-4:]


def upsert_env(path: str, key: str, value: str) -> None:
    """非破坏性 upsert (保留其余行); 无文件则创建。"""
    lines: list[str] = []
    if os.path.exists(path):
        lines = open(path, encoding="utf-8").read().splitlines()
    hit = False
    for i, ln in enumerate(lines):
        if ln.startswith(key + "="):
            lines[i] = f"{key}={value}"
            hit = True
            break
    if not hit:
        lines.append(f"{key}={value}")
    open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")


def verify(tok: str) -> bool:
    """干净 HOME 验真 (教训 4): 一次最小模型调用, 隔离本机 credentials。"""
    home = tempfile.mkdtemp(prefix="claude-token-verify-")
    env = {**os.environ, "HOME": home, "CLAUDE_CODE_OAUTH_TOKEN": tok}
    env.pop("ANTHROPIC_API_KEY", None)
    try:
        r = subprocess.run(
            ["claude", "-p", "reply exactly: TOKEN_OK", "--model", "claude-haiku-4-5-20251001"],
            env=env, capture_output=True, text=True, timeout=90, cwd=home,
        )
        return "TOKEN_OK" in (r.stdout or "")
    except Exception:
        return False
    finally:
        shutil.rmtree(home, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="claude setup-token 自动化配方 (人只点浏览器 + 贴 code)")
    ap.add_argument("--env-file", default=".env", help="token 写入的 env 文件 (默认 ./.env)")
    ap.add_argument("--no-verify", action="store_true", help="跳过干净环境验真 (省一次最小调用)")
    args = ap.parse_args()

    if shutil.which("claude") is None:
        die("找不到 claude CLI — 先装 Claude Code (https://claude.com/claude-code)")

    pid, fd = pty.fork()
    if pid == 0:
        # 教训 1: exec 前定宽, TUI 启动即知 400 列, token 单行打印。
        import fcntl, struct, termios
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 400, 0, 0))
        os.environ["COLUMNS"] = "400"
        os.execvp("claude", ["claude", "setup-token"])

    buf = b""
    url_shown = False
    fed = False
    deadline = time.time() + 600
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            buf += data
        clean = ANSI_RE.sub("", buf.decode("utf-8", "ignore"))
        if not url_shown:
            m = AUTH_URL_RE.search(clean.replace("\n", ""))
            if m:
                url_shown = True
                print("\n① 在浏览器打开并点 Authorize:\n")
                print("   " + m.group(0))
                print("\n② 授权后回调页会给一串 code#state, 整串粘贴到下面。\n")
        if url_shown and not fed:
            try:
                code = input("粘贴 code> ").strip()
            except EOFError:
                die("stdin 关闭, 未收到 code")
            if not CODE_RE.match(code):
                print("  ⚠ 形状不像 code#state, 仍尝试提交…")
            os.write(fd, code.encode())
            time.sleep(1.2)
            os.write(fd, b"\r")
            time.sleep(0.8)
            os.write(fd, b"\x1b[13u")  # 教训 2: kitty Enter
            time.sleep(0.8)
            os.write(fd, b"\n")
            fed = True
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            while True:
                r, _, _ = select.select([fd], [], [], 0.3)
                if not r:
                    break
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                buf += data
            break

    clean = ANSI_RE.sub("", buf.decode("utf-8", "ignore"))
    tokens = set()
    for line in clean.splitlines():  # 教训 3: 单行匹配
        tokens.update(TOKEN_RE.findall(line))
    if not tokens:
        die("未从 setup-token 输出中提取到 token — 重跑本脚本 (每次会重新授权)")
    tok = sorted(tokens, key=len)[-1]
    print(f"\n③ 提取到 token: {mask(tok)} (len {len(tok)})")

    if not args.no_verify:
        print("④ 干净环境验真中 (一次最小模型调用)…")
        if not verify(tok):
            die("token 验真失败 (401?) — 大概率提取到渲染碎片, 重跑本脚本重新授权")
        print("   ✓ 验真通过")

    upsert_env(args.env_file, "CLAUDE_CODE_OAUTH_TOKEN", tok)
    print(f"⑤ 已写入 {args.env_file} 的 CLAUDE_CODE_OAUTH_TOKEN。")
    print("   下一步: 重跑 path_init 即自动铺 repo secret + grill 评论区通道。")


if __name__ == "__main__":
    main()
