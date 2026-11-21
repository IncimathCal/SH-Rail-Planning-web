# -*- coding: utf-8 -*-
"""serve.py — 本地开发服务：仓库根静态文件 ＋ .ai 代解析 API（替代 python -m http.server）。

编辑器「导入线路」要直接吃 Adobe Illustrator 源图（内部 AIPrivateData 为 zstd 压缩、
解压后 7 GB 原生流，浏览器无法解析），故由本服务代解。解析一律 subprocess 调
tools/ai_parse.py（权威解析器，去重/改名/隐藏层过滤等坑全在那边，零改动）——
本服务只是通道，不产生、不修改任何线路数据，返回内容一律来自 ai_parse 产物。

用法：
  python -X utf8 tools/serve.py          # 监听 127.0.0.1:8000，Ctrl+C 停止
  编辑器入口 http://localhost:8000/editor.html

接口与要点：
- 静态服务：serve 仓库根（editor.html / src / data / import …），继承
  SimpleHTTPRequestHandler 的 translate_path 语义（.. 组件直接丢弃，天然防目录穿越）。
- POST /api/ai-parse：请求体 = .ai 原始字节（application/octet-stream），
  文件名从 X-Filename 头取（URL 编码，防中文乱码；仅作临时文件名/日志，不影响产物
  ——ai_parse 的 source 字段固定写 '远期.ai'）。上限见 MAX_BODY：注意源资产/远期.ai
  实测 1.86 GB，规格原定 512 MB 根本装不下真图，放大为 2 GiB（仅绑 127.0.0.1 的
  本地防呆线，非安全边界）。超限 413，且先收完剩余字节再应答（保证客户端能收到
  错误响应而不是连接被掐断）。
- 响应 200：ai_parse 产出的 fmt/import@1 JSON 原样字节返回（不重序列化，保证与
  import/远期图-全量.json 逐字节可比）；4xx/5xx：{"error":"<中文说明>"}。
- --line-note 常量与 CLAUDE.md 权威导出命令完全一致，保证 API 产物与
  import/远期图-全量.json 一致（84 条、两条线路备注齐全）。
- 原生尾部缓存：--native-cache 用 ai_parse 缺省 '零散/ai_native_tail.bin'（相对
  cwd），subprocess cwd=仓库根即命中 105 MB 缓存；缓存缺失时首次解析要解压 7 GB
  原生流（数分钟），期间 Handler 不设任何 socket 超时，绝不断开。
- ThreadingHTTPServer（HTTP/1.1 keep-alive）；解析段 threading.Lock 互斥——防两个
  并发请求同时走缓存缺失分支、双解压互写同一个缓存文件。
- 端口被占直接中文报错退出，不自动换端口（用户要求）。坑：HTTPServer 自带
  allow_reuse_address（Windows 的 SO_REUSEADDR 允许在有 0.0.0.0:8000 通配监听时
  仍绑上 127.0.0.1:8000——实测与用户还开着的 python -m http.server 静默共存，
  此时 localhost 若解析到 ::1 会打到旧服务、API 501），故绑定前先做 connect 探测：
  能连上＝已有监听＝报错退出；--port 可显式指定别的端口（默认 8000，绝不自动换）。
- 仅标准库。本服务只供本地开发，永不部署（红线：编辑器不入 GitHub Pages）。
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = '127.0.0.1'
PORT = 8000

MAX_BODY = 2 * 1024 ** 3      # POST 请求体上限（真图 1.86 GB，512 MB 装不下，见文件头）
READ_CHUNK = 8 * 1024 ** 2    # 请求体流式落盘块大小（8 MiB，避免整包进内存）
AI_PARSE = os.path.join(REPO_ROOT, 'tools', 'ai_parse.py')

# 与 CLAUDE.md 权威导出命令一致的两条 --line-note（可重复参数），勿改——
# 改了 API 产物的 note 就和 import/远期图-全量.json 对不上。
LINE_NOTES = [
    '4=与 3 号线共线，仅画不重复段',
    '苏淀沪线=即示范区线支线；原生对象名误作「苏淀沪连接线」（2026-11-21 用户裁定，'
    '与联络线层的苏淀沪连接线为两条不同的线）',
]

# 解析互斥：ai_parse 缓存缺失时会解压 7 GB 并重写 零散/ai_native_tail.bin，
# 并发双跑会互踩缓存文件。
PARSE_LOCK = threading.Lock()


class DevHandler(SimpleHTTPRequestHandler):
    """静态（仓库根）＋ POST /api/ai-parse。"""

    protocol_version = 'HTTP/1.1'   # keep-alive；所有自造响应都带 Content-Length

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=REPO_ROOT, **kwargs)

    # ------------------------------------------------------------ 工具

    def _json(self, code, msg):
        """统一错误应答：{"error": ...}（UTF-8，ensure_ascii=False）。"""
        body = json.dumps({'error': msg}, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _upload_name(self):
        """X-Filename 头（URL 编码）→ 干净的临时文件名；缺省 upload.ai。"""
        raw = self.headers.get('X-Filename')
        name = urllib.parse.unquote(raw, encoding='utf-8', errors='replace') if raw else ''
        name = os.path.basename(name.replace('\\', '/')).strip()
        if not name:
            name = 'upload.ai'
        if not name.lower().endswith('.ai'):
            name += '.ai'
        return name

    # ------------------------------------------------------------ 路由

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == '/api/ai-parse':
            self._json(405, '该接口仅接受 POST（请求体 = .ai 文件原始字节）')
            return
        super().do_GET()          # 静态文件 / 目录列表（与 python -m http.server 同语义）

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != '/api/ai-parse':
            self._json(404, '未知接口：%s（本服务仅提供 POST /api/ai-parse）' % self.path)
            return
        head = self.headers.get('Content-Length')
        if head is None:
            self.close_connection = True   # 没法知道还剩多少字节，收完这单就断开
            self._json(411, '缺少 Content-Length（不支持 chunked 请求体，请整包上传）')
            return
        try:
            length = int(head)
        except ValueError:
            self.close_connection = True
            self._json(400, 'Content-Length 非整数：%r' % head)
            return
        if length < 0:
            self.close_connection = True
            self._json(400, 'Content-Length 为负：%d' % length)
            return
        over = length > MAX_BODY
        name = self._upload_name()

        # 请求体流式落临时文件（不整包进内存；超限也把字节收完，客户端才收得到 413）
        job = tempfile.mkdtemp(prefix='ai-parse-')
        ai_path = os.path.join(job, name)
        out_path = os.path.join(job, 'out.json')
        try:
            received = 0
            with open(ai_path, 'wb') as f:
                while received < length:
                    chunk = self.rfile.read(min(READ_CHUNK, length - received))
                    if not chunk:
                        break        # 客户端中途断开
                    received += len(chunk)
                    if not over:
                        f.write(chunk)
            if received < length:
                self.close_connection = True
                self._json(400, '请求体不完整（收到 %d / %d 字节，客户端中断？）'
                           % (received, length))
                return
            if over:
                self._json(413, '请求体 %s 字节超过上限 %s（源资产/远期.ai 实测约 1.86 GB，'
                           '上限 2 GiB；传的这是啥？）'
                           % (format(length, ','), format(MAX_BODY, ',')))
                return
            self._parse(ai_path, out_path)
        except (ConnectionError, BrokenPipeError):
            self.log_message('客户端中途断开（%s，%d/%d 字节）', name, received, length)
        finally:
            shutil.rmtree(job, ignore_errors=True)   # 1.86 GB 临时件即用即删

    # ------------------------------------------------------------ 代解析

    def _parse(self, ai_path, out_path):
        cmd = [sys.executable, '-X', 'utf8', AI_PARSE, ai_path, '--out', out_path]
        for note in LINE_NOTES:
            cmd += ['--line-note', note]
        # cwd=仓库根：ai_parse 缺省缓存 '零散/ai_native_tail.bin' 为相对路径，
        # 命中即秒级；不设 subprocess 超时（无缓存首解数分钟属正常）。
        with PARSE_LOCK:
            cp = subprocess.run(cmd, cwd=REPO_ROOT, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                encoding='utf-8', errors='replace')
        if cp.returncode != 0 or not os.path.exists(out_path):
            tail = '\n'.join((cp.stderr or '').strip().splitlines()[-8:]) \
                or '\n'.join((cp.stdout or '').strip().splitlines()[-8:])
            detail = '：\n%s' % tail if tail else '（无输出）'
            self._json(500, 'ai_parse 解析失败（退出码 %d）%s' % (cp.returncode, detail))
            return
        data = open(out_path, 'rb').read()      # 产物原样字节返回，不重序列化
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        for ln in (cp.stdout or '').strip().splitlines()[-3:]:   # 服务台回显结论
            print('  [ai-parse] %s' % ln)
        sys.stdout.flush()


def _port_busy(host, port):
    """端口是否已有监听（connect 成功＝有）。SO_REUSEADDR 挡不住通配共存，必须主动探测。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        try:
            return s.connect_ex((host, port)) == 0
        finally:
            s.close()
    except OSError:
        return False


def main():
    global PORT
    ap = argparse.ArgumentParser(description='本地开发服务：仓库根静态文件 ＋ .ai 代解析 API')
    ap.add_argument('--port', type=int, default=PORT, help='监听端口（默认 %d，需显式指定才会变）' % PORT)
    args = ap.parse_args()
    PORT = args.port

    if _port_busy(HOST, PORT):
        sys.exit('启动失败：127.0.0.1:%d 已有服务在监听（多半是还开着的 python -m http.server，'
                 '它占着 0.0.0.0/[::]:%d 通配口）。请先停掉旧服务再启动本服务；'
                 '本服务不自动换端口（确要并开可 --port 显式指定）。' % (PORT, PORT))
    try:
        srv = ThreadingHTTPServer((HOST, PORT), DevHandler)
    except OSError as ex:
        sys.exit('启动失败：端口 %s:%d 绑定失败（%s）。请先停掉占用进程再试，'
                 '本服务不自动换端口。' % (HOST, PORT, ex))
    print('=' * 68)
    print('本地开发服务已启动（仅本机 %s:%d，静态根 = 仓库根）' % (HOST, PORT))
    print('  编辑器    http://localhost:%d/editor.html' % PORT)
    print('  .ai 解析  POST http://localhost:%d/api/ai-parse' % PORT)
    print('    请求体 = .ai 原始字节（application/octet-stream，上限 2 GiB），')
    print('    文件名放 X-Filename 头（URL 编码）；返回 fmt/import@1 JSON。')
    print('    已有 零散/ai_native_tail.bin 缓存时秒级~分钟级；缓存缺失首解')
    print('    需解压 7 GB 原生流（数分钟），期间请勿断开。Ctrl+C 停止。')
    print('=' * 68)
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')


if __name__ == '__main__':
    main()
