#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
easybot-ai-chat 通用转发 (零依赖, 单文件, 只用 Python 标准库)

它只做一件事: 给转发出去的请求补上 `Content-Type: application/json`。
为什么需要它: EasyBot 插件 API 发不出这个请求头(.NET 把 Content-Type 归在 content 上),
而绝大多数 OpenAI 兼容接口都强制要求它。**目标地址由请求路径决定, 换供应商不用改这里。**

启动:
    python3 forwarder.py            # 默认监听 0.0.0.0:18081
    python3 forwarder.py 18081      # 指定端口

插件里这样配(WebUI → 模型 页):
    relayBase = http://<这台机器的IP>:18081/proxy
    baseUrl   = 供应商真实地址, 例如 https://api.deepseek.com/v1

请求形如:
    POST /proxy/https/api.deepseek.com/v1/chat/completions
    → 转发到 https://api.deepseek.com/v1/chat/completions (自动补 Content-Type)
"""
import sys
import ssl
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TIMEOUT = 300          # 上游读写超时(秒)
HOP_BY_HOP = {'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
              'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'easybot-forwarder/1.0'

    def log_message(self, fmt, *args):          # 精简日志
        sys.stderr.write("[forwarder] %s %s\n" % (self.command, self.path))
        sys.stderr.flush()

    def _bad(self, code, msg):
        body = msg.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self):
        path = self.path
        if not path.startswith('/proxy/'):
            return self._bad(404, '用法: /proxy/<https|http>/<host>/<path>')
        rest = path[len('/proxy/'):]
        if '/' not in rest:
            return self._bad(400, '缺少目标主机')
        scheme, rest = rest.split('/', 1)
        if scheme not in ('http', 'https'):
            return self._bad(400, '只支持 http/https')
        if '/' not in rest:
            host, tail = rest, ''
        else:
            host, tail = rest.split('/', 1)

        # 查询串原样带上
        query = ''
        if '?' in tail:
            tail, query = tail.split('?', 1)
        target = '/' + tail + (('?' + query) if query else '')

        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None

        headers = {}
        for k, v in self.headers.items():
            if k.lower() in HOP_BY_HOP:
                continue
            headers[k] = v
        # ★ 关键: 补上插件发不出的请求头
        headers['Content-Type'] = 'application/json'
        headers['Host'] = host
        headers.setdefault('User-Agent', 'easybot-forwarder/1.0')
        if body is not None:
            headers['Content-Length'] = str(len(body))

        # 主机可以带端口(自建/Ollama 常见: 127.0.0.1:11434)
        if host.startswith('['):                       # IPv6: [::1]:1234
            hostname, _, port_s = host.partition(']')
            hostname = hostname[1:]
            port = int(port_s[1:]) if port_s.startswith(':') else (443 if scheme == 'https' else 80)
        elif host.count(':') == 1:
            hostname, port_s = host.rsplit(':', 1)
            port = int(port_s)
        else:
            hostname, port = host, (443 if scheme == 'https' else 80)

        try:
            if scheme == 'https':
                conn = http.client.HTTPSConnection(hostname, port, timeout=TIMEOUT,
                                                   context=ssl.create_default_context())
            else:
                conn = http.client.HTTPConnection(hostname, port, timeout=TIMEOUT)
            conn.request(self.command, target, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except Exception as e:
            return self._bad(502, '上游请求失败: %s: %s' % (type(e).__name__, e))

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in HOP_BY_HOP:
                continue
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)
        try:
            conn.close()
        except Exception:
            pass

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _forward


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18081
    srv = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print("[forwarder] 监听 0.0.0.0:%d  (插件 relayBase = http://<本机IP>:%d/proxy)" % (port, port))
    print("[forwarder] 它只补 Content-Type: application/json, 目标地址由请求决定")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[forwarder] 已停止")


if __name__ == '__main__':
    main()
