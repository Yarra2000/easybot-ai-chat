#!/bin/sh
# 发布前门禁: 全部通过才允许打包/部署
set -e
echo "── ⓪ 所有源码文件语法检查(打包不做语法检查, 坏源码会被静默打包!) ──"
for f in main.js lib/*.js lib/tools/*.js; do
  node --check "$f" || { echo "   ❌ 语法错误: $f"; exit 1; }
done
echo "   ✅ $(ls main.js lib/*.js lib/tools/*.js | wc -l) 个文件语法正确"
if [ -f forwarder/forwarder.py ]; then
  python3 -m py_compile forwarder/forwarder.py && echo "   ✅ forwarder.py 语法正确"
  rm -rf forwarder/__pycache__
fi
echo "── ① WebUI 静态检查(语法/标签配对/元素 id 一致性) ──"
node dev/check-webui.js
echo "── ② WebUI 运行检查(假 DOM 里真跑一遍 9 个标签页) ──"
node dev/check-pages.js
echo "── ③ 源码自测 ──"
node dev/selftest.js > /tmp/gate-selftest.log 2>&1 || { tail -5 /tmp/gate-selftest.log; exit 1; }
tail -3 /tmp/gate-selftest.log
echo "── ④ 打包 ──"
node dev/build-bundle.js > /dev/null && echo "   ai_chat.js 已生成"
echo "── ⑤ 产物自测 ──"
node dev/selftest-bundle.js > /tmp/gate-bundle.log 2>&1 || { tail -5 /tmp/gate-bundle.log; exit 1; }
tail -2 /tmp/gate-bundle.log
echo
echo "✅ 全部门禁通过"
