# -*- coding: utf-8 -*-
"""查看器相机让位冒烟（2026-11-27 真机两病灶修复验证；gitignored 自建工具链，不进正式树）。

做法沿用 CLAUDE.md「编辑器整页冒烟」套路：临时站点副本（build/smoke/site/，拷正式树
build/net 真数据）＋自写静态服务（/__hold 挂起推迟 load 事件、/__release 放行）＋
chrome --headless=new --dump-dom 取回 #probeOut（探针=probe.js，断言三类线聚焦后
bbox 端点投影 ≥ 面板右缘＋站名余量）。

用法：python -X utf8 build/smoke/smoke.py
退出码 0=全过；1=有 FAIL；2=探针未跑完（超时/没取到 probeOut）。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))   # worktree 根（smoke.py → smoke → build → 根）
SITE = os.path.join(HERE, 'site')
NET_SRC = r'E:/10.项目/261120远期图网页/build/net'   # 正式树真数据（只读）
PORT = 8210
CHROME = r'C:/Program Files/Google/Chrome/Application/chrome.exe'

RELEASE = threading.Event()
HOLD_TIMEOUT = 120.0   # 兜底：探针卡死时也放行 load，别让 chrome 等成铁疙瘩


class HoldHandler(SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802（http.server 约定）
        if self.path.startswith('/__hold'):
            RELEASE.wait(timeout=HOLD_TIMEOUT)
            self.send_response(204)
            self.end_headers()
        elif self.path.startswith('/__release'):
            RELEASE.set()
            self.send_response(204)
            self.end_headers()
        else:
            super().do_GET()

    def log_message(self, *a):   # 静默访问日志
        pass


def build_site():
    """拷临时站点：src（viewer.js 末尾挂 __v 钩子）＋ assets/basemap/net ＋ probe.html。"""
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(os.path.join(SITE, 'src'))
    for name in ('viewer_core.js',):
        shutil.copy2(os.path.join(ROOT, 'src', name), os.path.join(SITE, 'src', name))
    # viewer.js：只在副本的 boot() 前挂调试钩子（源码是 IIFE，内部函数外部取不到）
    with open(os.path.join(ROOT, 'src', 'viewer.js'), encoding='utf-8') as f:
        vjs = f.read()
    hook = ("  // ---- 冒烟探针钩子（只挂副本，不进正式树）----\n"
            "  try { globalThis.__v = { S, setFocus, cameraPadding, fitFocusLine, totalBbox,"
            " setLinePanelCollapsed, panelVisible }; } catch (e) { console.warn('__v hook fail', e); }\n\n"
            "  boot();")
    assert vjs.count('\n  boot();') == 1, 'viewer.js 收口结构变了，钩子插入点需人工核对'
    vjs = vjs.replace('\n  boot();', '\n' + hook)
    with open(os.path.join(SITE, 'src', 'viewer.js'), 'w', encoding='utf-8') as f:
        f.write(vjs)
    shutil.copytree(os.path.join(ROOT, 'assets'), os.path.join(SITE, 'assets'))
    shutil.copytree(os.path.join(ROOT, 'basemap'), os.path.join(SITE, 'basemap'))
    shutil.copytree(NET_SRC, os.path.join(SITE, 'net'))
    shutil.copy2(os.path.join(HERE, 'probe.js'), os.path.join(SITE, 'probe.js'))
    # probe.html ＝ index.html 拷贝改造：head 插 __hold（推迟 load），viewer.js 后插探针
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        html = f.read()
    html = html.replace('<head>',
        '<head>\n    <script async src="/__hold"></script>', 1)
    html = html.replace('  <script src="src/viewer.js"></script>',
        '  <script src="src/viewer.js"></script>\n  <script src="probe.js"></script>', 1)
    assert '/__hold' in html and 'probe.js' in html, 'index.html 结构变了，插桩点需人工核对'
    with open(os.path.join(SITE, 'probe.html'), 'w', encoding='utf-8') as f:
        f.write(html)


def serve():
    import functools
    handler = functools.partial(HoldHandler, directory=SITE)   # 服务 site/ 目录
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), handler)   # 只听 127.0.0.1（::1 坑）
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def run_chrome(profile):
    # ⚠ 不用 --virtual-time-budget：它会把 setTimeout/rAF 全冻结（挂起请求推迟 load 的
    # 探针场景翻车，见 CLAUDE.md MapLibre 血泪教训）——实时运行，靠 dump-dom 等 load 事件。
    cmd = [CHROME, '--headless=new', '--disable-gpu', '--no-first-run',
           '--user-data-dir=' + profile, '--window-size=1600,900',
           '--dump-dom', 'http://127.0.0.1:%d/probe.html' % PORT]
    return subprocess.run(cmd, capture_output=True, timeout=180)


def main():
    print('[smoke] 搭临时站点 …')
    build_site()
    httpd = serve()
    print('[smoke] 静态服务 http://127.0.0.1:%d/（site/ = worktree 副本＋正式树真数据）' % PORT)
    profile = os.path.join(HERE, 'profile')
    if os.path.isdir(profile):
        shutil.rmtree(profile)
    try:
        t0 = time.time()
        proc = run_chrome(profile)
        dt = time.time() - t0
    finally:
        httpd.shutdown()
    dom = proc.stdout.decode('utf-8', errors='replace')
    m = re.search(r'<pre id="probeOut">(.*?)</pre>', dom, re.S)
    if not m:
        print('[smoke] FAIL：dump-dom 里没有 #probeOut（探针没跑完？chrome 退出码 %s，耗时 %.1fs）'
              % (proc.returncode, dt))
        print('[smoke] stderr 摘要：', proc.stderr.decode('utf-8', errors='replace')[:2000])
        sys.exit(2)
    out = json.loads(m.group(1))
    print('[smoke] 探针耗时 %.1fs；meta: lines=%s view=%s panel=%s pad=%s'
          % (dt, out.get('meta', {}).get('lines'), out.get('meta', {}).get('view'),
             out.get('meta', {}).get('panel'), out.get('meta', {}).get('pad')))
    for line in out.get('checks', []):
        print('  ' + line)
    for w in out.get('meta', {}).get('labelWidths', []):
        print('  站名实测 ' + w)
    print('[smoke] ' + str(out.get('summary')))
    sys.exit(0 if out.get('fails') == 0 else 1)


if __name__ == '__main__':
    main()
