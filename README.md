# AI 对话助手 · EasyBot 插件

一个仿 **MaiBot** 的拟人化大模型对话插件，并且能把 **EasyBot 的其它插件 / 服务端扩展** 变成大模型可以调用的工具。

- 插件 ID：`easybot_ai_chat`
- 入口：`ai_chat.js`（单文件构建产物；源码在 `main.js` + `lib/`，用 `node dev/build-bundle.js` 生成）
- 基于官方 SDK：`easybot-sdk` 0.3.2（文档里 0.4.0 的新接口用特性检测做了兼容，不会因为版本低而报错）

---

## 目录

- [一、它能做什么](#一它能做什么)
- [二、安装](#二安装)
- [三、配置](#三配置)
- [四、它在群里怎么说话](#四它在群里怎么说话)
- [五、命令](#五命令)
- [六、WebUI 面板](#六webui-面板)
- [七、让其它插件被大模型调用（重点）](#七让其它插件被大模型调用重点)
- [八、目录结构](#八目录结构)
- [九、注意事项与安全](#九注意事项与安全)
- [十、开发与自测](#十开发与自测)
- [十一、真实环境实测结论（重要）](#十一真实环境实测结论重要)
- [十二、自定义模型 / API / 提示词风格](#十二自定义模型--api--提示词风格)
- [十三、WebUI 调回复逻辑（预设 + 决策模拟器）](#十三webui-调回复逻辑预设--决策模拟器)
- [十四、自然语言 → MC 指令（分人分级 + 返回控制台输出）](#十四自然语言--mc-指令分人分级--返回控制台输出)
- [十五、让 AI 用「本服的指令」而不是原版指令](#十五让-ai-用本服的指令而不是原版指令)
- [十六、指令知识库（让 AI 在选工具时就能看见本服指令）](#十六指令知识库让-ai-在选工具时就能看见本服指令)
- [十七、实战案例：把「加白名单」接到 EasyWhitelist 模组](#十七实战案例把加白名单接到-easywhitelist-模组)
- [十八、指令来源优先级：本服知识库优先，Wiki 只做兜底](#十八指令来源优先级本服知识库优先wiki-只做兜底)
- [十九、实战复核：为什么"给 PlayerG 急迫X无限"当时没生效](#十九实战复核为什么给-playerg-急迫x无限当时没生效)
- [二十、知识库即权限来源 + 只读状态查询](#二十知识库即权限来源--只读状态查询)
- [二十一、权限：按群分类 + WebUI 可视化](#二十一权限按群分类--webui-可视化)
- [二十三、网络传输：默认走原生 .NET HTTP，**不需要转发**](#二十三网络传输默认走原生-net-http不需要转发)
- [二十四、新功能：让 AI 查**离线**玩家数据（背包 / 装备 / 末影箱 / 统计）](#二十四新功能让-ai-查离线玩家数据背包--装备--末影箱--统计)
- [许可证](#许可证)

---

## 一、它能做什么

| 功能 | 说明 |
| --- | --- |
| 拟人化聊天 | 回复前有"打字"延迟（按字数计算）、长回复自动拆成几条短消息连续发出、随机引用原消息 / @对方 / 补一个表情 |
| 人设 | 名字、身份、性格、说话风格、背景故事、额外规则，可在 WebUI 里直接改，改完立即生效 |
| 短期记忆 | 每个群 / 每个私聊独立维护上下文，按条数与字符数自动裁剪 |
| 长期记忆 | 手动（`/ai remember` / `memory_save` 工具）或自动（每隔 N 轮让模型自己抽取要点存下来） |
| 群聊分寸感 | **听得到**所有人的话（写进上下文），但只有 @我 / 叫名字 / 关键词 / 回复我 / 刚聊过的连续对话 才会开口 |
| 防刷屏 | 每个会话独立冷却时间 + 每分钟回复上限 + 全局并发上限 |
| 工具调用 | 内置 13 个工具（服务器信息、玩家列表、执行命令、广播、PAPI 查询、RPC 调用…），并可加载任意其它插件注册的工具 |
| 权限范围 | 群白/黑名单、私聊白/黑名单、管理员 QQ 列表、分群开关 |
| 界面 | WebUI 面板：状态 / 工具 / 记忆与会话 / 人设 / 对话测试 |
| 稳定性 | 所有外部调用都有超时和 try/catch，litedb / network / httpServer 缺失时自动降级，不会拖垮 EasyBot |

---

## 二、安装

**第 0 步：确认入口文件 `ai_chat.js` 存在**

入口 `ai_chat.js` 是**单文件构建产物**。

- **下载的是发布包** → 包里**已附带**一个用**默认配置**构建好的 `ai_chat.js`，可直接用 ✓
- **从仓库 clone 的**（或你改了 `main.js` / `lib/` 之后）→ 需要自己重新构建：
  ```bash
  cd easybot-ai-chat
  node dev/build-bundle.js          # 生成 ai_chat.js（约 400KB）
  ```

> **为什么仓库源码里没有现成的 `ai_chat.js`** ✗：打包会把**运行配置**一起烘进产物里
> （包括 **API Key / 服务器令牌**）—— 如果把"带自己配置的产物"提交上去，等于公开密钥 ✗。
> 所以仓库只留源码；发布包里附的是**用默认配置构建**的干净产物 ✓（不含任何密钥 ✓）。
> 你自己部署时，用默认值/WebUI 填配置即可，也可以随时重新构建 ✓。

1. 把整个 `easybot-ai-chat` 目录（含刚生成的 `ai_chat.js`）复制到 `EasyBot安装目录/plugins/` 下（目录名随意）。
2. 重启 EasyBot（首次必须重启才会被识别）。
3. 控制台看到下面这样的日志就成功了：

```
[ai-chat] AI 对话助手 v1.2.0 已加载 (plugin_id=easybot_ai_chat)
=====================================
 AI 对话助手 v1.2.0 已启用
 模型: deepseek-chat @ https://api.deepseek.com/v1
 群聊触发方式: mention
=====================================
[ai-chat] 工具网关已启动: http://127.0.0.1:20777  (其它插件可 POST /register 注册工具)
```

4. 进 WebUI 的 **AI 对话助手** 页面，或插件配置页，填上 **API Key**。

> 发布给别人时，可以删掉 `easybot-sdk/` 和 `dev/` 两个目录，它们只用于代码提示和本地自测，不影响运行。

---

## 三、配置

三种填法都支持（优先级从低到高）：代码里的默认值 → 插件自带 `config.json` → EasyBot 配置分组 `main`。

最省事的是 **插件配置页**（插件启用时会注册动态表单），需要填的核心项：

| 配置路径 | 默认值 | 说明 |
| --- | --- | --- |
| `llm.baseUrl` | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址，可填到 `/v1` 也可直接填完整的 `/chat/completions` |
| `llm.apiKey` | 空 | **必填**，密钥只保存在本地 |
| `llm.model` | `deepseek-chat` | 模型名，如 `gpt-4o-mini` / `qwen-plus` / `moonshot-v1-8k` |
| `llm.temperature` | `0.9` | 越高越活泼 |
| `llm.maxTokens` | `800` | 单次最大输出 |
| `llm.maxToolRounds` | `3` | 一条消息最多几轮工具调用 |
| `llm.authMode` | `header` | 鉴权方式。`header`=标准 Authorization 头；`query`=把密钥拼到 URL（某些 EasyBot build 发不了自定义请求头时用）；`none`=不带鉴权 |
| `llm.authQueryParam` | `api_key` | `authMode=query` 时使用的参数名 |
| `llm.selfTestOnEnable` | `false` | 启用插件时真实调用一次模型做自检（会打印环境诊断与工具链路结果） |
| `persona.*` | 见默认值 | 名字 / 身份 / 性格 / 说话风格 / 背景 / 额外规则 |
| `behavior.groupMode` | `mention` | 群聊触发方式 |
| `behavior.randomChance` | `0.05` | `random` 模式下的随机插话概率 |
| `behavior.prefixes` | `["ai","AI"]` | 触发前缀 |
| `behavior.keywords` | `[]` | 触发关键词 |
| `behavior.continuationWindowSec` | `150` | 刚回复过之后，多久内继续说话算"接着聊" |
| `behavior.cooldownSec` | `3` | 同一会话回复冷却 |
| `behavior.maxRepliesPerMinute` | `8` | 同一会话每分钟回复上限 |
| `behavior.maxConcurrent` | `3` | 全局同时进行的模型请求上限 |
| `behavior.allowSkip` | `false` | 是否给模型"这次可以不插话"的选项。**默认 false** —— 一旦被叫到/触发就必须回（开着时实测会出现"叫它却不理人"）|
| `behavior.notifyWhenUnconfigured` | `false` | 没配 API Key 时是否在群里提示。默认 **false**（只写日志，不打扰群） |
| `humanize.*` | 见默认值 | 打字速度、分段长度、引用/@/表情概率 |
| `memory.autoSummaryEvery` | `10` | 每 N 轮自动抽取一次长期记忆，`0` = 关闭 |
| `tools.enabled` | `true` | 是否启用工具调用 |
| `tools.allowRunCommand` | `true` | **是否允许 AI 执行服务器命令**（见安全章节） |
| `tools.commandBlacklist` | `stop,op,deop,ban,...` | 禁止执行的命令 |
| `tools.gateway.port` | `20777` | 工具网关端口 |
| `tools.gateway.token` | 空 | 网关令牌，填了以后其它插件注册工具需要带上 |
| `tools.discover.enabled` | `true` | 是否自动扫描其它插件的 `ai-tools.json`（需要 System.IO） |
| `tools.defaultServerToken` | 空 | 多台 MC 服务器在线时，默认查询哪一台（留空=取第一台并在结果里注明） |
| `tools.allowSendMessage` | `false` | 是否允许 AI 主动发消息（配合 `proactiveAllowedGroups` 限定范围） |
| `tools.proactiveAllowedGroups` | `[]` | 允许主动发消息的群号，留空=不限制 |

也支持扁平写法，例如在 `config.json` 里直接写：

```json
{
  "apiKey": "sk-xxxxxx",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "personality": "话痨，喜欢用颜文字",
  "allowRunCommand": true,
  "commandBlacklist": "stop,op,ban"
}
```

**配置形态自动兼容**：以下四种写法都会被正确识别（内部统一映射到层级结构），所以不管 EasyBot 表单是按字段平铺保存、还是按「分组容器」嵌套保存，都能读到：

```jsonc
{ "llm": { "apiKey": "x" } }          // 层级式
{ "llm.apiKey": "x" }                 // 点号式
{ "apiKey": "x" }                     // 扁平式（走别名表）
{ "llmGroup": { "apiKey": "x" } }     // 动态表单的容器分组式
```

另外，如果当前版本里表单分组的 groupId 不是 `main`，插件会自动遍历所有配置分组、挑出明显属于本插件的那份来用（见 `lib/config.js` 的 `readUserConfig` / `normalizeUserConfig`）。数字/布尔字符串、逗号分隔的数组都会自动转换。

---

## 四、它在群里怎么说话

`behavior.groupMode` 三种模式：

| 模式 | 行为 |
| --- | --- |
| `mention`（默认） | 只有被 @、被叫名字、命中前缀/关键词、回复了它的消息，或者处于"连续对话窗口"内才回复。其它消息它只是听着。 |
| `always` | 每条群消息都回（靠冷却和每分钟上限限制频率）。 |
| `random` | 被叫到时一定回，否则按 `randomChance` 概率随机插话。 |

几个细节：

- **连续对话**：它刚回复过之后 `continuationWindowSec` 秒内，同一个人继续说（`continuationAnyone=true` 时是任何人说）它会接着聊，不用每次 @。
- **听得见**：即使不回复，群消息也会进入上下文（`recordAllGroupMessages` 可关闭），所以它知道群里刚才在聊什么。
- **不会不理人**：默认**不给**模型"拒绝说话"的选项（`behavior.allowSkip=false`），所以被叫到就会回；真想让它可以挑着回话，把这项设为 `true` 即可。
- **拟人化**：回复按标点拆成最多 `segmentMaxCount` 条，每条间隔按字数计算，模拟真人打字。

---

## 五、命令

命令前缀默认 `/ai`（`commands.prefix` 可改）：

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `/ai help` | 所有人 | 帮助 |
| `/ai status` | 所有人 | 运行状态：模型、密钥、工具数、记忆数 |
| `/ai reset` | 所有人 | 清空本会话上下文 |
| `/ai remember <内容>` | 所有人 | 记一件事（长期记忆） |
| `/ai memory [关键词]` | 所有人 | 查看记忆；`/ai memory clear` 清空（管理员） |
| `/ai tools` | 所有人 | 列出当前可用工具 |
| `/ai on` / `/ai off` | 管理员 | 开/关本会话的 AI |
| `/ai persona <字段> <值>` | 管理员 | 改人设，字段支持 名字/性格/风格/身份/背景/规则 |
| `/ai test <内容>` | 管理员 | 直接问一次模型（不影响上下文） |

管理员 = `access.adminUserIds` 里的 QQ，或群里的群主/管理员。

---

## 六、WebUI 面板

插件启用后，WebUI 侧边栏会出现 **AI 对话助手** 分组：

- **总览**：模型 / 密钥 / 工具网关 / 记忆统计，一键重载配置、重新扫描工具、重启网关、清空上下文；并显示其它插件的接入示例代码。
- **工具**：当前所有工具及其来源（内置 / 其它插件 / 服务端扩展）。
- **记忆与会话**：查看、添加、删除长期记忆；查看每个会话的消息数、开关 AI、查看最近消息、单独清空。
- **人设**：可视化编辑人设，保存立即生效。
- **对话测试**：走真实的大模型 + 工具链路做测试，不会影响群里的上下文。

---

## 七、让其它插件被大模型调用（重点）

大模型看到的是标准的 **function calling** 工具表。任何能力只要注册进来，模型就能调用。共 **四种** 接入方式：

### 方式 1：HTTP 工具网关（推荐，最通用）

本插件启动时会开一个 HTTP 服务（默认 `127.0.0.1:20777`）。其它 EasyBot 插件只要用 SDK 的 `network` / `httpServer` 对接即可：

**A. 你的插件暴露 HTTP 接口**（用 SDK 的 `httpServer`）：

```js
// 你的插件里
const sid = httpServer.CreateServer(18888, 'my_plugin_tools', '127.0.0.1');
httpServer.OnPost(sid, '/tool/sign_in', (req, res) => {
    const args = JSON.parse(req.body || '{}').arguments;   // 注意: 参数在 arguments 字段
    res.status = 200;
    res.body = JSON.stringify({ ok: true, player: args.player, days: 7 });
});
await httpServer.StartServerAsync(sid);
```

**B. 把能力注册给 AI 对话助手**：

```js
// 你的插件里 (enable 事件中做一次即可)
await network.post('http://127.0.0.1:20777/register', JSON.stringify({
    plugin: 'my_plugin',                       // 工具名会加前缀: my_plugin__sign_in
    tools: [{
        name: 'sign_in',
        description: '给指定玩家签到, 返回连续签到天数',
        parameters: {
            type: 'object',
            properties: { player: { type: 'string', description: '玩家名' } },
            required: ['player']
        },
        callback: { type: 'http', url: 'http://127.0.0.1:18888/tool/sign_in', method: 'POST' }
    }]
}));
```

之后模型就能调用 `my_plugin__sign_in` 了。取消注册：`POST /unregister {plugin:"my_plugin"}`。

**网关接口一览**

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /tools` | 列出全部工具（配置了令牌时要带 `X-AI-Tool-Token`） |
| `POST /register` | 注册工具，body：`{plugin, token?, tools:[...]}` |
| `POST /unregister` | 注销该插件的所有工具，body：`{plugin}` |
| `POST /invoke` | 反向调用某个工具，body：`{name, arguments, callbackUrl?}`。**异步契约**：立即返回 `202 {requestId, pollUrl}`；结果用 `GET /result?requestId=...` 轮询，或提供 `callbackUrl` 由插件回调（见下方说明） |
| `GET /result?requestId=x` | 查询 `/invoke` 的结果：`202`=执行中，`200 {status:"done",result}`=完成 |

### 方式 2：`ai-tools.json` 约定文件（零代码，启动自动发现）

在你自己的插件目录里放一个 `ai-tools.json`：

```json
{
  "tools": [
    {
      "name": "query_coins",
      "description": "查询玩家的金币数量",
      "parameters": {
        "type": "object",
        "properties": { "player": { "type": "string" } },
        "required": ["player"]
      },
      "callback": { "type": "http", "url": "http://127.0.0.1:18888/tool/query_coins" }
    }
  ]
}
```

参考模板：本插件目录下的 `ai-tools.example.json`。
也可以直接写在你自己 `manifest.json` 的 `ai_tools` 字段里。

> 自动发现需要文件系统访问（ClearScript 的 `System.IO`）。如果当前环境不可用，日志会提示，此时请用方式 1 或方式 3。

### 方式 3：服务端扩展 RPC（调用服务器上的 EasyBot 插件/模组）

配置 `tools.bridgeTools`，或写进 `ai-tools.json`：

```json
{
  "name": "get_server_date",
  "description": "获取服务器时间",
  "parameters": { "type": "object", "properties": {} },
  "callback": {
    "type": "bridge-rpc",
    "serverToken": "",
    "identifier": "bridge:test",
    "method": "get_date"
  }
}
```

不填 `serverToken` 时，只有一台服务器在线才会自动选择（多台会报错提示你指定）。服务端扩展也可以反过来用 RPC 主动注册工具：

```csharp
// 服务端扩展侧 (EasyBot BridgeClient)
BridgeClient.getInstance().rpcCall("easybot_ai_chat", "register_tool", jsonObject);
// jsonObject = { "plugin": "my_ext", "tools": [ ...同上... ] }
```

### 方式 4：内置工具（开箱即用）

| 工具名 | 作用 |
| --- | --- |
| `eb_list_servers` | 列出在线的 MC 服务器与令牌 |
| `eb_server_info` | 服务器版本、是否支持 PAPI |
| `eb_server_players` | 在线玩家列表 |
| `eb_run_command` | 以控制台身份执行命令（走黑名单校验） |
| `eb_broadcast` | 全服广播 |
| `eb_placeholder` | 查询 PlaceholderAPI 变量 |
| `eb_rpc_call` | 调用服务器上任意扩展的 RPC 方法 |
| `eb_list_extensions` | 列出服务器已安装的扩展 |
| `eb_list_tools` | 让模型自己查看有哪些工具 |
| `memory_save` / `memory_search` / `memory_forget` | 长期记忆读写 |
| `get_current_time` | 当前时间 |

### 插件之间还能这样通信

除了注册工具，AI 对话助手还对外提供 RPC 接口（服务端扩展可通过 `rpcCall("easybot_ai_chat", ...)` 调用）：

| RPC 方法 | 参数 | 说明 |
| --- | --- | --- |
| `register_tool` | `{plugin, tools:[...]}` | 注册工具 |
| `chat` | `{prompt, senderName?}` | 让 AI 处理一段文本并返回回复 |
| `status` | 无 | 返回运行状态 |

---

## 八、目录结构

```
easybot-ai-chat/                     ← 放进 EasyBot/plugins/ 的就是这个目录
├── manifest.json            插件声明 (entry 指向 ai_chat.js)
├── ai_chat.js               ★ 单文件构建产物 = 实际运行的入口
├── README.md
├── ai-tools.example.json    给其它插件抄的工具声明模板
│
├── main.js                  多文件源码入口 (开发用)
├── lib/                     多文件源码
│   ├── util.js              通用工具 + 跨 build 的集合归一化 / plainify
│   ├── config.js            配置(默认值 + 别名 + 兼容 .NET Dictionary + 动态表单)
│   ├── httpclient.js        HTTP 适配层(自动适配不同 build 的 network API)
│   ├── memory.js            短期上下文 + 长期记忆(litedb, 可降级内存)
│   ├── llm.js               OpenAI 兼容客户端 + 工具调用循环
│   ├── humanize.js          拟人化(清洗/分段/延迟/引用)
│   ├── chat.js              对话主流程(CQ 解析/触发/限流/命令/发送)
│   ├── webui.js             WebUI 管理面板
│   └── tools/
│       ├── registry.js      工具注册中心
│       ├── builtin.js       内置工具(服务器/RPC/记忆)
│       ├── factory.js       把声明式定义变成可执行 handler
│       ├── gateway.js       HTTP 工具网关(其它插件注册入口)
│       └── discover.js      扫描其它插件的 ai-tools.json (依赖 System.IO)
│
├── easybot-sdk/             官方 SDK 声明文件(仅 IDE 提示)
└── dev/                     开发与自测(发布时可删)
    ├── build-bundle.js      多文件 → 单文件 打包器
    ├── mock-easybot.js      模拟 EasyBot 运行时
    ├── selftest.js          463 项源码自测
    ├── selftest-bundle.js   12 项打包产物冒烟测试
    └── probe-plugin/        运行时环境探测插件(只写日志, 不发消息)

../example-plugin-for-ai-chat/      示例: 另一个插件如何接入(独立目录)
```

> **打包/发布**：修改 `lib/` 或 `main.js` 后必须重新执行 `node dev/build-bundle.js`，
> `ai_chat.js` 才会更新。发布包 = `manifest.json` + `ai_chat.js` + `README.md` + `ai-tools.example.json`。

## 九、注意事项与安全

- **API Key 会明文保存在 EasyBot 配置里**，请只在信任的环境使用。
- **执行服务器命令是高危能力**：`tools.allowRunCommand` 控制开关，`tools.commandBlacklist` 是黑名单（默认拦掉 `stop/op/deop/ban/kick/whitelist/reload/restart` 等）。建议按需收紧，也可以在配置里直接关掉。AI 可能会被群里的恶意消息诱导去执行命令，**不要把管理员身份的机器人放在不受信任的群里**。
- **工具网关默认只监听 `127.0.0.1`**，开启 `allowRemote` 才能外网访问；建议同时设置 `gateway.token`。
- **成本**：群聊里每条被触发的消息都会调用一次模型，`maxToolRounds` 越高消耗越大；`memory.autoSummaryEvery` 也会额外调用（可设为 0 关闭）。记忆里只保留最近 `memory.maxMessages` 条上下文。
- **【已知问题】** 官方文档说明插件系统的部分异步 API 可能无法正确 await。本插件所有异步调用都包在 try/catch + 超时里，失败只会影响当次回复。
- **版本**：SDK 0.3.2 与文档里的 0.4.0 有差异（例如 `Group` 主键、`Action Session`、`NodeSegment`）。本插件只使用 0.3.2 已声明的接口，并对可选属性做了防御性判断，在更高版本上同样可用。

---

## 十、开发与自测

```bash
node dev/selftest.js           # 源码自测: 463 项
node dev/build-bundle.js       # 生成单文件 ai_chat.js
node dev/selftest-bundle.js    # 打包产物冒烟测试: 12 项
```

自测用 `dev/mock-easybot.js` 模拟 EasyBot 运行时，覆盖：配置解析（4 种形态）、CQ 码解析、
.NET 集合归一化、HTTP 适配层（3 种 build 形态）、触发判断、完整对话+工具调用、分段发送、
沉默、私聊、长期记忆、命令、HTTP 网关注册/调用/轮询、RPC 注册、WebUI 面板、禁用清理。

写代码时的约定：

- **发布版是单文件**：因为真实 EasyBot 的 `require` 不可用（见下一节），所有模块由
  `dev/build-bundle.js` 打进 `ai_chat.js`，内部用一个极小的模块表代替 `require`。
- 源码用 CommonJS（`require('./x.js')`）编写，便于阅读与自测；打包器负责内联。
- **不要对宿主对象调用原生方法**：`threading.setTimeout.bind(...)` / `fn.call(...)`
  在 ClearScript 的宿主代理上都会报 `is not a function`，要用闭包包一层。
- 所有 `bus.on` / HTTP handler 都套 try/catch，异常不冒泡到宿主。

---

## 十一、真实环境实测结论（重要）

以下结论来自在真实 EasyBot（镜像 `miuxue/easybot:dev-full`，Docker 容器 `easybot`）上的实测，
不是推测。**这个 build 与官方文档（SDK 0.3.2 / 0.4.0）有明显差异**，插件已全部按实测结果适配：

| 能力 | 实测结果 | 插件如何适配 |
| --- | --- | --- |
| `require('./x.js')` | ❌ **完全不可用**。加载器把相对路径解析成 `app/appdata/plugins/<id>/...`（丢了开头斜杠），相对/绝对/裸路径全部失败 | 发布为 **单文件插件**，内部自带模块表（`dev/build-bundle.js`） |
| `network.request({...})` | ❌ 报 `HttpApi does not contain a definition for 'request'` | `lib/httpclient.js` 自动降级 |
| `network.get(url)` / `network.post(url, body)` | ✅ 可用 | 自动选中该写法并记入日志 |
| 自定义请求头（Authorization） | ❌ **无法发送**（任何带 headers 的签名都失败） | 提供 `llm.authMode`：`header`(默认) / `query`(把密钥放 URL) / `none`；并在日志中给出明确提示 |
| `httpServer` 的 handler | ⚠️ **不会被 await**：`async` handler 里 await 之后写的 `res` 会返回空 body | `/invoke` 改为「立即 202 + requestId」的异步契约，新增 `GET /result` 轮询；`/register`、`/tools` 等保持同步实现 |
| `event.Messages` | ⚠️ 是 .NET 集合代理：**没有 `.length`，也没有 `.get()`**。多策略探测后确认可用的是 **`ToArray()`**（日志会打印 `消息片段枚举策略: ToArray`） | 改为 **CQ 码优先**解析 `RawMessage`（`[CQ:at,qq=]` / `[CQ:reply,id=]` / `[CQ:image]`…），片段枚举仅作兜底并逐个策略尝试 |
| `event.Chain` | ✅ `Count` / `AsString()` 可用 | 用于兜底文本 |
| `packet.List`（如玩家列表） | ⚠️ 同样是 .NET 集合：**没有 `.get()`、也没有 `.length`**，用 `.get()` 遍历会得到空列表（实测踩坑：明明有 1 人在线却报 0 人） | 改用 `util.toArray`（多策略，实测命中 `ToArray()`），元素按 `PlayerName` 等属性直接读取；`plain()` 也改成对集合走 `toArray` |
| `MessageChain` 构建 | ✅ `new MessageChain().Text().At().NextLine().Image().Face()` 正常（自检 Count=6） | 发送链路按文档实现 |
| `archive` 命名空间 | ❌ 不存在（`archive is not defined`） | 代码已 `typeof` 守卫，故**打包内的 `config.json` 不会被读取**，请用 WebUI 配置页 |
| `System.IO` / `System` | ❌ `typeof System === 'undefined'` | `ai-tools.json` 自动发现不可用（日志会提示），请改用 **HTTP 工具网关** 注册工具 |
| `config.getConfigObject('main')` | ✅ 可用，未配置时返回 `null` | 主配置路径；另有 4 种配置形态兼容 |
| `config.getAllConfigs()` | ⚠️ 返回 .NET `Dictionary` 代理（`Object.keys` 只会得到方法名） | 用 `Keys` + 索引器读取 |
| 动态配置表单 (`form.*`) | ✅ 全部组件创建成功（容器/文本/数字/开关/下拉） | 启动时注册表单 |
| `menu_ready` + `pluginMenu.register` | ✅ 注册成功，WebUI 出现「AI 对话助手」 | 管理面板正常 |
| `rpc.on` / `litedb` / `sessions` / `framework` / `threading` | ✅ 可用 | 直接使用 |
| `Object.keys(宿主对象)` | 会返回大量 .NET/LINQ 扩展方法名，**不能当作真实成员判断**；`typeof x.foo === 'function'` 也不代表可调用 | 一律用 try/catch + 多策略探测，不依赖成员枚举做分支 |

### 实测验证到的完整链路

同一容器内实测（模型用本机 mock 服务替代，避免消耗额度）：

```
插件加载 → 启用 → 注册配置表单 → 注册 WebUI 菜单 → 启动工具网关(20777)
→ 消息链构建自检(Count=6) → 调用大模型(带 13 个工具定义 + 人设 system prompt)
→ 模型返回 tool_calls(eb_list_servers) → 插件执行工具 → 工具结果回填
→ 模型给出最终回复 → 外部 wget 调用 /health /tools /register /invoke /result 全部成功
```

### 对你的环境意味着什么

1. **要接真实大模型，必须先解决"发不了请求头"的问题**（这是该 build 的限制，不是插件的 bug）。三种选择：
   - 本机/内网部署一个不需要鉴权的推理服务（如 Ollama），`llm.baseUrl` 指向它；
   - 用 one-api / new-api / LiteLLM 之类的转发网关，由网关注入密钥，插件只连内网网关；
   - 升级 EasyBot 到 `network.request` 可用的版本（届时插件会自动切回标准写法，无需改配置）。
2. **`ai-tools.json` 自动发现**在这个 build 上不可用（没有文件系统访问），请让其它插件用
   HTTP 工具网关注册（方式 1），或写到 `tools.httpTools` / `tools.bridgeTools` 配置里。
3. 其余功能（人设、记忆、拟人化分段、触发策略、工具调用、WebUI 面板）均已实测可用。

---

## 十二、自定义模型 / API / 提示词风格

三件事都可以自定义，**全部在 WebUI 里改，保存即生效，不用改代码也不用重启**。

### 1) 自定义模型

| 配置 | 说明 |
| --- | --- |
| `llm.baseUrl` | 任意 OpenAI 兼容接口。填到 `/v1` 即可，也可直接填完整的 `.../chat/completions` |
| `llm.apiKey` | 密钥 |
| `llm.model` | 模型名，原样透传给接口 |
| `llm.temperature` / `llm.maxTokens` | 采样温度与单次输出上限 |
| `llm.apiStyle` | `tools`（新式 function calling，默认）/ `functions`（兼容旧式接口） |
| `llm.authMode` | `header`（标准）/ `query`（密钥拼进 URL）/ `none` |
| `llm.extraHeaders` | 需要额外请求头时用（仅当该 EasyBot 支持自定义请求头） |

常见填法：

```jsonc
// DeepSeek
{ "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" }
// OpenAI
{ "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" }
// 本地 Ollama（不需要密钥）
{ "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b", "apiKey": "", "authMode": "none" }
// one-api / new-api 之类的转发网关
{ "baseUrl": "http://192.0.2.10:3000/v1", "model": "gpt-4o-mini", "apiKey": "sk-xxx" }
```

### 2) 自己写提示词决定回复风格

`persona` 这一组就是提示词本体，会按下面顺序拼成 system prompt：

```jsonc
{
  "persona": {
    "name": "小助手",                                  // 名字（也会作为群聊触发词）
    "identity": "示例服B的老玩家，服务器助手",      // 身份
    "personality": "高冷但嘴硬心软，偶尔阴阳怪气",      // 性格
    "speakingStyle": "说话像东北大哥，爱用'整挺好''必须的'，短句",  // 说话风格
    "background": "在服务器里待了三年",                // 背景故事
    "extraRules": "不讨论政治；不透露自己是 AI",        // 硬性规则
    "exampleDialogue": "用户: 今天玩啥\n你: 整挺好，上号!"  // 示例对话（对风格影响最大）
  }
}
```

三种改法，任选：

- **WebUI 配置页**：插件配置里的「人设」分组（含示例对话）
- **WebUI 面板 → 人设页**：可视化编辑，保存即生效
- **群里发命令**（管理员）：`/ai persona 风格 说话像猫娘，句尾加"喵"`

另外还有一组 `humanize.*` 控制**怎么发**（不是说什么）：打字延迟、单条最大字数、最多拆几条、引用/@/表情概率。

### 3) 优先级与生效时机

```
WebUI 面板 / 命令保存的覆盖  >  插件配置页里的值  >  代码默认值
```

保存后立即生效（插件监听 `config_changed` 重新读取），不需要重启 EasyBot，也不影响正在进行的会话。

### ⚠️ 当前这个 EasyBot build 的实际限制

插件本身支持标准 `Authorization` 请求头，但**这个 build 的 network API 发不了自定义请求头**，所以：

- 用**免鉴权的本地/内网服务**（Ollama、内网网关）→ 直接可用，配 `authMode: none`
- 你的服务端支持把密钥放查询串 → 配 `authMode: query`（参数名可配）
- 需要标准请求头的云服务（DeepSeek/OpenAI 等）→ 二选一：
  1. 在 EasyBot 所在宿主机上跑一个很小的转发（由它注入 `Authorization` 再转发出去），插件指向这个本地转发；
  2. 升级 EasyBot 到 `network.request` 可用的版本，插件会自动切回标准写法。

### 接云 API 的通用做法（本次实测有效）

当前 build 的插件**不仅发不了 `Authorization`，也发不了 `Content-Type`**（Agnes 直接回 400
`only supports Content-Type: application/json`）。所以本机部署了一个 nginx 转发容器
（见同目录外的 `agnes-relay/`），同时注入这两个头。插件侧配置：

```jsonc
{ "baseUrl": "http://192.0.2.10:18081/v1", "model": "agnes-3.0-flash",
  "authMode": "none", "apiKey": "" }
```

转发只监听 docker 网关 IP，密钥存在转发配置里（600 权限），插件配置里不放密钥；
换供应商只改 `proxy_pass` 一行。

**QQ 图片可以被 Agnes 正常抓取**（实测拿群里的真实签名 URL 验证：返回「一只黑色的猫，
它的眼睛和鼻子部分发着亮光…」），所以视觉功能在 QQ 场景下是可用的。

转发还开了请求体日志（`relay-body.log`），排查"插件到底发了什么"时很有用。

---

## 十三、WebUI 调回复逻辑（预设 + 决策模拟器）

WebUI 面板新增了 **「回复逻辑」** 页，改完**立即生效、不用重启**（覆盖存在 litedb，优先级高于配置文件）。

### 六个预设（点一下即应用）

| 预设 | 效果 |
| --- | --- |
| **安静助手**（推荐） | 只在 @它 或叫名字时回；连续对话窗口 60s |
| **只认 @** | 只有 @它 才回，连叫名字、回复它、前缀都不理 |
| **群友感** | 被叫到就回；刚聊过会接着聊（180s）；偶尔（3%）主动插话 |
| **话痨** | 几乎每条群消息都回，靠冷却 8s + 每分钟 5 条压制 |
| **只认前缀** | 只有 `ai` / `小助手` 开头才回，最不打扰，且不接续 |
| **随缘插话** | 很少主动说话（1%）；被叫到才回，不接续 |
| **暂停回复** | 任何群消息都不回（仍然记录上下文，随时可再打开） |

### 可以细调的项目

全局回复开关、群聊模式（mention/always/random）、触发前缀、额外称呼、触发关键词、
连续对话窗口（秒）、是否允许群内任何人接话、**被叫名字也回**（`behavior.nameTrigger`）、
**回复它也算叫它**（`behavior.replyTrigger`）、随机插话概率、回复冷却、每分钟上限。

触发条件一共 6 个，各有开关：
`@它`（**始终生效、无法关闭**）、`叫名字`、`触发前缀`、`触发关键词`、`回复它`、`连续对话窗口`。
想做到"只有 @ 才回"：关掉后 5 个即可（或用「只认 @」预设）。

### 决策模拟器

输入一句话 + 勾选「@了机器人 / 回复了机器人 / 刚聊过」，点测试就会告诉你：

```
会回复 ｜ 原因: @我  (解析到: @你 ai 服务器有几个人)
不回复 ｜ 原因: mention 模式下未被叫到  (解析到: 随便聊聊)
```

这样不用在群里反复试，直接能看到判定结果和原因。

> 顺带修了个底层问题：`savePersonaOverride` 原先也是**直接往 litedb 写对象**，
> 真机上写不进去 —— 也就是 WebUI/命令改的人设重启后会丢。现在人设覆盖和行为覆盖
> 都统一存 **JSON 字符串**，能正确持久化。

---

## 十四、自然语言 → MC 指令（分人分级 + 返回控制台输出）

玩家在群里用自然语言提需求 → 大模型判断该执行什么指令 → 插件校验身份权限 →
在服务器执行 → 把**控制台输出**回给模型 → 模型用人话回答。

### 关键：执行身份其实是"控制台"，`playerName` 只用于 PAPI

**这一节推翻了早期的一个错误结论**，过程值得记录：

早期现象：以 `CONSOLE` 或不存在的名字执行时，`help`/`list`/`seed` 全报
`Unknown or incomplete command`，而 `say`/`me`/`tell` 正常。当时误判为"必须是真实在线的玩家"。

后来翻 EasyBot 模组源码（`easybot-team/easybot-mod`）发现：

```java
// BridgeBehaviorImpl.runCommand —— playerName 只用来解析 PAPI 变量
ServerPlayer p = getServer().getPlayerList().getPlayerByName(playerName);
if (enablePapi) finalCommand = PlaceholderManager.getInstance().replacePlaceholders(command, playerName, p);
return COMMAND_IMPL.DispatchCommandAsync(commandToRun).join();

// CommandImpl.DispatchCommand —— 以控制台 + 全权限下发
CommandSourceStack stack = new CommandSourceStack(..., PermissionSet.ALL_PERMISSIONS,
        "EasyBotCommandDispatcher", ..., server, null);
server.getCommands().performPrefixedCommand(stack, command);
```

**真正的原因是 `enablePapi=true`**：模组会拿 `playerName` 去解析 `%player_name%` 之类的 PAPI 变量，
某些服务端上这个替换过程会**无条件把指令字符串改坏** —— 于是 `list` 变成
`Unknown or incomplete command`、`time set day` 报 `Expected float`、
`effect give PlayerG haste` 报 `found trailing data`，看起来像"指令不存在/没权限"，其实是指令被改坏。

**重要更正**：早期以为"玩家离线才会坏"，后来实现在线也一样坏 ——
19:22 那次 EasyBot 自带功能能跑通，是因为它**默认不开 PAPI**。

对照实验（同一台服，同一个玩家，且他**在线**）：

| 指令 | `enablePapi=true` | `enablePapi=false` |
| --- | --- | --- |
| `list` | ❌ Unknown or incomplete command | ✅ `There are 5 of a max of 114514 players online: ...` |
| `effect give PlayerG haste 999999 9` | ❌ found trailing data | ✅ `Applied effect Haste to PlayerG` |
| `seed` | ❌ Unknown or incomplete command | ✅ `Seed: [-2869178296547820569]` |

**最终修法（最稳）**：指令里**没有 `%占位符%` 就完全不开 PAPI**。PAPI 只在指令真的用到
`%player_name%` 这类变量时才有意义，其余情况一律跳过，既保留能力又不会被改坏。

**所以：管理员不在线也能正常管服。** 插件默认 `enablePapi=true` +
`tools.papiOnlyWhenOnline=true`：执行者在线时正常解析 PAPI，离线时自动跳过，
既保留 `%player_name%` 能力又不会把指令改坏。

执行身份优先级（一般不需要动，`playerName` 只影响 PAPI 变量）：

1. 调用方显式指定的 `playerName`
2. **请求者绑定的 MC 玩家**（`db.GetSocialAccount('qq', QQ号).Users`，`tools.runAsBoundPlayer` 控制）
3. 配置的 `tools.consoleName` 兜底

> 注意：SDK 里数据库命名空间叫 **`db`**（不是 `database`），写错了真机上是 `undefined`。

### 权限等级（`permissions` 配置 + WebUI「指令权限」）

| 等级 | 能力 |
| --- | --- |
| 0 | 禁止执行任何指令（默认，陌生人） |
| 1 | 只能执行 `safeCommands`（list/tps/say/me/tell/time query...） |
| 2 | 还能执行 `mediumCommands` |
| 3 | 除硬黑名单外都能执行（高危） |

判定顺序：**硬黑名单（`tools.commandBlacklist`，任何等级都拒绝）** → safe → medium →
**未列出的一律按高危处理**（`permissions.unknownCommandLevel`，默认 3）。

身份来源：`permissions.userLevels`（`"QQ:等级, QQ:等级"`）→ `permissions.users` 对象 →
群主 `groupOwnerLevel` → 群管理 `groupAdminLevel` → `defaultLevel`。

### 指令清单（`tools.commandHints`）

不同服务端指令树差别很大（本机的 Fabric 1.21.11 上 `help`/`list`/`seed` 对普通玩家
就是不可用的，`time set day` 报 `Expected float` —— 可能是 CMI 之类的指令插件改写过）。
所以加了一项：管理员在 WebUI 填「本服可用指令清单」，会注入提示词，帮模型选对指令。

### 相关工具

- `eb_run_command` —— 执行并返回控制台输出（已去掉颜色代码，`§r,` 还原成换行）
- `eb_my_permissions` —— 查调用者的等级、可执行范围、绑定的 MC 玩家

### HTTP 网关（方便外部/自己测试）

- `POST /invoke` 支持 `context` 指定身份：`{"name":"eb_run_command","arguments":{...},"context":{"senderId":"...","senderRole":"admin"}}`
- `POST /chat` 端到端提问：`{"prompt":"...","senderId":"...","senderRole":"..."}` → 202 + requestId，轮询 `/result`

> 注意：EasyBot 的 httpServer **不会 await handler**，所以 `/chat` 和大模型调用一样
> 必须走 202 + 轮询，否则响应体是空的（这个大坑 `/invoke` 当初也踩过）。

---

## 十五、让 AI 用「本服的指令」而不是原版指令

不同服务端指令不一样。比如白名单，原版是 `/whitelist`，但有的模组要用 `/easywhitelist`。
光靠提示词让模型猜很容易用错，所以做了**两层保障**：

### 第 1 层：意图规则 → 注册成独立工具（最可靠）

配置 `tools.commandRules`，**每行一条**（用 `|` 分隔，方便填在 WebUI 单行输入框里）：

```
工具名 | 中文标题(给模型理解意图) | 指令模板 | 参数 | 需要等级
```

例子（白名单改用模组指令）：

```
add_whitelist|把玩家加入白名单|easywhitelist add {player}|player:玩家名|3
del_whitelist|把玩家移出白名单|easywhitelist remove {player}|player:玩家名|3
```

效果：

- 每条规则会**注册成一个独立工具**（`eb_add_whitelist` 等），参数是结构化的。
  模型只要判断"用户想加白名单"，就调这个工具，**指令由模板渲染，它完全不用拼指令语法**。
- 规则也会**注入提示词**（`本服已配置的专用指令工具…`），引导模型优先用它们。
- 等级可以用规则里的第 5 列单独指定（不填就按常规 safe/medium/未知 分类判定）。
- 也支持 JSON 数组写法：`[{"name":"add_whitelist","title":"...","command":"...","args":[{"name":"player","desc":"玩家名"}],"level":3}]`

### 第 2 层：指令改写（兜住"模型还是用了原版指令"）

配置 `tools.commandRewrites`，**每行一条** `正则=替换`：

```
^whitelist\b=easywhitelist
```

模型即使通过 `eb_run_command` 发了 `whitelist add Steve`，执行前也会被自动改成
`easywhitelist add Steve`，并记日志：

```
[ai-chat] 指令按改写规则调整: whitelist add Steve -> easywhitelist add Steve  (规则: ^whitelist\b=easywhitelist)
```

结果里同时保留 `command`（实际执行）和 `rawRequested`（模型原本请求的），方便排查。

### 实测验证

```
已注册 2 条自定义指令规则: eb_add_whitelist, eb_del_whitelist
工具列表(18 个) 含: eb_add_whitelist, eb_del_whitelist

等级0 成员调用 eb_add_whitelist:
  denied: True | 需要等级: 3 | 你的等级: 0 | 说明: 这个操作需要等级 3, 你是 0
  → 日志里没有任何"执行规则指令"记录 (没有被下发到服务器)
```

WebUI 位置：**AI 对话助手 → 指令权限 → 专用指令规则 / 指令改写规则**（改完即时生效）。

---

## 十六、指令知识库（让 AI 在选工具时就能看见本服指令）

把本服常用指令写成知识库后，模型**在决定调哪个工具的那一刻**就能看到，而不是埋在
system prompt 深处。三层配合，越靠前越可靠：

| 层 | 配置 | 作用 |
| --- | --- | --- |
| ① 专用指令工具 | `tools.commandRules` | 最高频、语法特殊的操作做成独立工具，指令由模板渲染，模型**不需要会拼指令** |
| ② 工具描述里的清单 | `tools.commandBook` | 高频指令直接写进 `eb_run_command` 的**工具描述**（默认前 8 条），选工具时看得见 |
| ③ 可检索知识库 | `tools.commandBook` + `eb_find_command` | 完整清单按关键词检索，**长尾按需取**，不占常规上下文 |

### 配置格式（每行一条，`|` 分隔）

```
指令 | 说明 | 关键词(逗号分隔, 可选) | 需要等级(可选)
```

例：

```
easywhitelist add {player}|把玩家加入白名单|白名单,加白,whitelist|3
easywhitelist remove {player}|把玩家移出白名单|白名单,移出,whitelist|3
list|查看在线玩家|在线,人数,几个人|
time set day|把时间设为白天|白天,时间|
easyhome {player}|把玩家传送回家|回家,传送,home|3
easygive {player} {item} {count}|给玩家发物品|给物品,发东西,give|3
```

- 超过 `tools.commandBookInDescription`（默认 8）条的会写一句"还有 N 条，用 `eb_find_command` 查"。
- 旧的 `tools.commandHints` 仍然兼容（没有 `|` 的行当成只有说明的条目）。
- 关键词支持别名，模型说"加白"也能检索到 `easywhitelist add`。

### `eb_find_command` 工具

模型不确定本服写法时（例如它只知道原版 `/whitelist`），会先查：

```
query: 白名单
→ easywhitelist add {player}  —— 把玩家加入白名单  [需要等级 3]
   easywhitelist remove {player}  —— 把玩家移出白名单  [需要等级 3]
```

查不到时会明确回复"知识库里没有匹配…本服没有这个功能"，避免它硬猜。

WebUI 位置：**AI 对话助手 → 指令权限 → 指令知识库(常用指令)**，改完即时生效
（配置变更会自动重建 `eb_run_command` 的工具描述）。

---

## 十七、实战案例：把「加白名单」接到 EasyWhitelist 模组

服务器装的是 [简易白名单 EasyWhitelist](https://www.mcmod.cn/class/9265.html)（Fabric，把白名单/封禁/OP
从 UUID 改成**按玩家名**，给离线模式服务器用）。原版 `/whitelist` 在这里不好使，要用：

| 模组指令 | 作用 |
| --- | --- |
| `easywhitelist add <玩家名>` | 按名字加入白名单 |
| `easywhitelist remove <玩家名>` | 按名字移出白名单 |
| `easyban <玩家名>` / `easypardon <玩家名>` | 按名字封禁 / 解封 |
| `easyop <玩家名>` / `easydeop <玩家名>` | 按名字给 / 撤管理员 |

> 注意：**这些指令严格区分大小写**；且 `easywhitelist` 必须带子命令，裸执行只会得到
> "Unknown or incomplete command"。

### 本插件的配置（三层都配上了）

```
# tools.commandBook（写进 eb_run_command 的工具描述 + 可检索）
easywhitelist add {player}|按玩家名加入白名单(严格区分大小写)|白名单,加白,whitelist|3
easywhitelist remove {player}|按玩家名移出白名单|白名单,移出白名单|3
easyban {player}|按玩家名封禁|封禁,封号,ban|3
easypardon {player}|按玩家名解封|解封,解ban,pardon|3
easyop {player}|按玩家名给管理员|给op,管理员,op|3
easydeop {player}|按玩家名撤销管理员|撤销op,deop|3
list|查看在线玩家|在线,人数|          # 其余常用指令略

# tools.commandRules（注册成独立工具, 模型不用会拼指令）
add_whitelist|按玩家名把玩家加入白名单|easywhitelist add {player}|player:玩家名(区分大小写)|3
del_whitelist|按玩家名把玩家移出白名单|easywhitelist remove {player}|player:玩家名|3
ban_player|按玩家名封禁玩家|easyban {player}|player:玩家名|3
pardon_player|按玩家名解封玩家|easypardon {player}|player:玩家名|3
op_player|给玩家管理员权限|easyop {player}|player:玩家名|3
deop_player|撤销玩家管理员权限|easydeop {player}|player:玩家名|3

# tools.commandRewrites（模型万一还是发原版指令, 自动纠正）
^whitelist(?=\s|$)=>easywhitelist
^pardon(?=\s|$)=>easypardon
^ban(?=\s|$)=>easyban
^op(?=\s|$)=>easyop
^deop(?=\s|$)=>easydeop
```

### 两个关键的实现细节

1. **改写用 `=>` 作分隔符**（老写法 `正则=替换` 也兼容）。因为正则里经常含 `=`，
   例如前瞻 `(?=\s|$)` —— 按第一个 `=` 切会把正则切坏，规则直接失效。
2. **改写发生在权限校验之前**。`whitelist` 本来就在硬黑名单里，但因为先被改写成
   `easywhitelist`（不在黑名单），所以等级 3 的用户能正常执行；而普通成员依然会被等级拦住。

### 真机验证

```
① 模型发 "whitelist" -> 执行 "easywhitelist"
   日志: 指令按改写规则调整: whitelist -> easywhitelist  (规则: ^whitelist(?=\s|$)=>easywhitelist)

② 规则工具 eb_del_whitelist(玩家=__NotARealPlayer__)
   执行: easywhitelist remove __NotARealPlayer__
   服务器返回: "Player is not whitelisted"      ← 模组真实响应, 链路完全打通
```

配好之后，群里说「**把 Steve 加进白名单**」，模型会调 `eb_add_whitelist` →
执行 `easywhitelist add Steve` → 把控制台输出（如 `Added Steve to the whitelist`）回给用户。

---

## 十八、指令来源优先级：本服知识库优先，Wiki 只做兜底

### 优先级（写进了 `eb_run_command` 的工具描述和提示词）

```
① tools.commandRules 专用工具   （最高频、语法特殊的操作, 模型不用会拼指令）
② tools.commandBook 知识库      （写进工具描述 + 可用 eb_find_command 检索）
③ eb_search_wiki 查 Minecraft Wiki 原版写法（仅供参考, 必须告知用户"原版写法未必适用本服"）
```

### 关于运行时抓 Wiki —— 实测结论（重要）

**代码做了，但这台机器上跑不通**，原因值得记录：

- 插件的 `network.get` **确实能访问公网**（拿到了响应）。
- 但 `zh.minecraft.wiki` 和 `minecraft.wiki` 都会返回**反爬挑战页**：
  `<html><title>Please wait</title>...`（不是 JSON）。
- 根因：EasyBot 的 `network` API **发不了自定义请求头**，所以设不了 User-Agent；
  Wiki 的 WAF 因此拒绝。而容器里用 `wget`（自带 UA）直连是 **200 OK**。
- 试过用本机 nginx 转发补 UA —— **Wiki 对转发容器直接返回 403**（WAF 看来源指纹）。

所以：`tools.wiki.enabled` **默认关闭**，并把失败提示做成可操作的 ——
一旦被反爬挡住，会明确告诉模型"别再试了，回到本服知识库"，避免它反复重试浪费轮次。
如果你的网络环境能过 WAF，在 WebUI 里打开这个开关即可用。

### 所以「把 Wiki 抄进知识库」才是正解

已经预先写进 `tools.commandBook` 的 **45 条常用指令**（9 条只读安全 / 36 条会改状态需等级 3）：

- **本服模组指令**（已实测）：`easywhitelist add/remove`、`easyban`、`easypardon`、`easyop`、`easydeop`
- **只读安全**：`list`、`seed`、`time query daytime`、`weather query`、`difficulty`、`me`、`say`、`tell`、`help`
- **会改状态（等级 3）**：`time set`、`weather`、`gamemode`、`give`、`clear`、`tp`、`effect`、`enchant`、
  `xp`、`summon`、`kill`、`difficulty`、`gamerule`、`setblock`、`fill`、`spawnpoint`、`setworldspawn`、
  `worldborder`、`title`、`tellraw`、`playsound`、`tag`、`scoreboard`、`spectate`

每条都带**中文说明 + 关键词别名**（"加白"、"封号"、"给物品"、"传送"…），所以用自然语言提需求时，
模型检索得到、也看得懂。

### 怎么继续扩充

WebUI → **AI 对话助手 → 指令权限 → 指令知识库**，每行一条：

```
指令 | 说明 | 关键词(逗号分隔) | 需要等级
```

装了什么模组/插件，就去它的介绍页把指令抄进来（就像 EasyWhitelist 那样），比运行时抓网页可靠得多。

---

## 十九、实战复核：为什么"给 PlayerG 急迫X无限"当时没生效

群里的需求是「给PlayerG急迫X的效果，持续时间无限」，模型试了 3 次都报解析错，最后只回了句
"我换个标准写法试试" —— **当时确实什么都没生效**。用 MC 服务端日志 + `data get entity` 复核：

```bash
# 只读指令查实体数据(不依赖任何插件)
data get entity PlayerG active_effects
```

PAPI 修好之前的 3 次尝试（全被改坏）：

```
effect give PlayerG instant infinite  -> Can't find element 'minecraft:instant'   (效果名也错)
effect give PlayerG haste infinite    -> Expected integer
effect give PlayerG haste 999999      -> found trailing data
```

PAPI 修好之后（`papi=False` 自动跳过替换），**一次成功**：

```
effect give PlayerG haste infinite 9  -> "Applied effect Haste to PlayerG"
```

复核实体数据确认（**duration: -1 就是真正无限**）：

```
[{amplifier: 9b, id: "minecraft:haste", duration: -1, hidden_effect: {duration: -1}}]
```

### 本服 effect 指令的正确写法

```
effect give <玩家> <效果> <时长> <强度>
```

- 时长：整数秒（如 `999999`）或 **`infinite`**（真正无限，NBT 里显示 `duration: -1`）
- 强度：从 0 起 —— **0 = I 级，9 = X 级**（急迫X 就是 `haste ... 9`）
- 给某人急迫X无限：`effect give <玩家> haste infinite 9`
- 查询现有：`effect clear <玩家> <效果>` 清除 / `data get entity <玩家> active_effects` 查看

### 排查这类问题的通用手法

1. **看 MC 服务端日志**（容器 `<服务端>` → `/app/logs/latest.log`）——
   能看到玩家聊天、EasyBot 收到的消息、以及插件报错。
2. **用只读指令验证状态**：`data get entity <玩家> active_effects`、
   `data get entity <玩家> Dimension` 等，不改任何数据就能确认"到底生效没有"。
3. **对比 PAPI 开关**：同样的指令 `papi=True` 报错、`papi=False` 正常 → 就是变量替换把指令改坏了。

---

## 二十、知识库即权限来源 + 只读状态查询

### 等级以知识库为准

`permissions.check` 现在会**先查知识库**：如果某条指令命中了知识库条目且该条目声明了等级，
就以它为准；否则才走常规的 safe / medium / 未知 分类。模板里的 `<玩家>`、`{player}` 会当通配符匹配：

```
data get entity <玩家> Pos        | 查询玩家坐标        | ... | 1
data get entity <玩家> Inventory  | 查询玩家背包内容    | ... | 3
```

于是同一类指令可以**按敏感度分开授权**（实测）：

```
等级0 群友: data get entity PlayerG Pos        -> ❌ 需要等级 1, 你是 0
等级0 群友: data get entity PlayerG Inventory  -> ❌ 需要等级 3, 你是 0
等级3 (你): data get entity PlayerG Pos        -> ✅ [1.05...E7d, -22.0d, 1.69...E7d]
```

### 预置的只读查询（等级 1，群友可用）

| 指令 | 说明 |
| --- | --- |
| `data get entity <玩家> Pos` | 坐标（返回 `[x, y, z]` double，科学计数法） |
| `data get entity <玩家> Health` | 血量 |
| `data get entity <玩家> Dimension` | 所在维度 |
| `data get entity <玩家> XpLevel` | 经验等级 |
| `data get entity <玩家> foodLevel` | 饥饿值 |
| `data get entity <玩家> active_effects` | **身上的药水效果**（`amplifier` 9=X级，`duration` -1 = 无限）← 用来验证"到底生效没有" |
| `data get block <坐标>` | 指定坐标的方块 |

**隐私相关（等级 3，仅管理员）**：

| 指令 | 说明 |
| --- | --- |
| `data get entity <玩家> Inventory` | 背包内容 |
| `data get entity <玩家> EnderItems` | 末影箱内容 |

这样 AI 在回答"XX 现在在哪""有没有人受伤""效果生效了吗"时，会走**只读查询**而不是乱改服务器状态。

---

## 二十一、权限：按群分类 + WebUI 可视化

### 设计（按实际需求）

- **群主 = 最高等级**（`groupOwnerLevel`，默认 3）
- **其他所有群友默认最低等级**（`defaultLevel`，默认 0）—— 包括群管理（`groupAdminLevel` 默认 0），需要就单独给
- **同一个人在不同群可以有不同等级**（按群分类）

### 配置格式（WebUI 指令权限里填，或权限页可视化编辑）

每行一个群：

```
群号 | QQ:等级, QQ:等级
```

例：

```
123456789 | 100000001:3, 100000006:2
999888777 | 10001:1
```

也支持 JSON：`{"123456789":{"100000001":3}}`

判定顺序：
`按群的显式配置` → `全局 userLevels` → `群主(自动最高)` → `群管理(默认最低)` → `默认等级`

### WebUI 「权限」页

- **实时生效表格**：每个群一行，显示 `群主/群管理/其他人` 的默认等级，
  以及该群**单独配置过的成员**（昵称 + QQ + 等级，从高到低排序）
- 全局配置的用户单独列一区
- 可以直接编辑「按群分类的等级」「全局等级」「默认/群主/群管理/未列出指令」的等级并保存
- 保存走 litedb 覆盖，**立即生效不用重启**；「恢复配置值」清掉覆盖

### 实测（群 123456789，你=3 级，其余人=0 级）

```
你(100000001)  执行 give     -> ✅ Gave 1 [Diamond] to PlayerG
普通群友        执行 list     -> ❌ 需要等级 1, 你是 0
普通群友        执行 give     -> ❌ 需要等级 3, 你是 0
群管理          执行 give     -> ❌ 需要等级 3, 你是 0   (按需求群管理也是默认最低)
```

> 注意：**命令被拦住 ≠ 什么都问不了**。只读类问题（谁在线、服务器状态）走的是插件内置工具
> （`eb_server_players` 等），**不经过指令权限**，所以普通群友照样能问"现在谁在线"。

### 另外：知识库已精简

按需求去掉了"查谁受伤了"这类诊断查询（`execute as @a run data get ...`、`data get entity ... Health` 等），
`tools.commandBook` 现在聚焦在**你要 AI 执行的那些指令**上，共 47 条。

---

## 二十三、网络传输：默认走原生 .NET HTTP，**不需要转发**

插件**自己就能发出带完整请求头的 HTTP 请求**（反射调用 .NET 的 `HttpClient`），
所以**默认不需要任何转发容器** —— 装好插件、填上 API Key 就能用 ✓

- 启动日志里能看到用的是哪种方式：`已启用原生 .NET HTTP(可自控 Content-Type 等请求头)` ✓
- 万一某个 EasyBot build 不支持，才需要 `forwarder/forwarder.py`（用法见 `forwarder/` 目录 ✓）
- **换 API 供应商只改 3 个配置项**，不用动转发 ✓

---

## 二十四、新功能：让 AI 查**离线**玩家数据（背包 / 装备 / 末影箱 / 统计）

### EasyBot 自己是怎么查离线背包的（调研结论）

主程序**看不到** MC 的世界文件（容器只挂了 `logs` 和 `data`），所以：

```
群里发关键词 + 玩家名
  → 主程序按 UUID 索引（不是玩家名）
  → 核心 → 服务端模组: bridge 包 ReadNbtData(playerUuid, NbtDataType)
  → 模组 PlayerDataProvider.getPlayerData(UUID) 读 world/playerdata/<uuid>.dat (离线 NBT)
  → 返回 JSON → 主程序用纹理包渲染成图片发群里
```

代码级证据（解剖 `easybot-fabric-0.3.1`）：
`nbt/PlayerDataProvider.class`、`bridge/packet/NbtDataTypeEnum.class`、
`impl/BridgeBehaviorImpl.class` 里的 `ReadNbtData(String, NbtDataTypeEnum)`。

### 我们的插件也能用（SDK 文档里没写）

枚举桥接对象的方法时发现 **`Bridge.ReadNbtData` 直接暴露给插件**：

```js
db.GetPlayerByName(name).Uuid          // → UUID
await bridge.ReadNbtData(uuid, nbtEnum) // → { Message, Data, ... }
```

三个坑（都踩过并已修）：

1. **`Data` 必须用 `Data.ToString()` 读** —— `JSON.stringify(Data)` 得 `{}`、
   `String(Data)` 得 `"[object Object]"`（正好 15 字符，误导了一阵）
2. **同一属性读第二次会变**：`Count` 第一次读 64、再读变 1 ——
   所以每件物品必须**一次性**抽成普通 JS 对象（`extractItem`），否则数量全变 1
3. **UUID 是账号级的，多服务器各有独立存档**：实测同一玩家在示例服B背包满满、
   在示例服A背包为空而末影箱很满 → `read()` 现在**收集所有服务器的结果**，
   工具支持 `server` 参数（模糊匹配），并回报 `allServers`
4. 第二个参数是**枚举**，直接传数字只有 `0` 能过重载 →
   用反射 `Assembly.GetEntryAssembly()` 找到 `NbtDataType` 再 `Enum.Parse` 出真枚举值

### 工具 `eb_player_data`

| 参数 | 说明 |
| --- | --- |
| `player` | MC 玩家名（区分大小写） |
| `server` | 可选，指定服务器（多服必备） |
| `what` | `inventory` / `stats` / `advancements` |

**权限**：查自己绑定的号永远允许；查他人需要 `tools.playerData.minLevel`（默认 1 级）。

**实测输出**（示例服B，离线玩家）：

```
inventory → 占格 25, deepslate x64, stone x64, golden_carrot x57, shulker_box x7(7组)
            装备: chest=elytra, offhand=firework_rocket x35
            末影箱: firework_rocket x217(4组), deepslate x211(4组), gravel x64, ...
stats     → 总游戏时长(ticks) 10756897, 死亡 378 次, 击杀生物 264212, 击杀玩家 202,
            挖掘: stone x8066, deepslate x7368, netherrack x2909 ...
advancements → ⚠️ 模组 0.3.1 未实现(枚举声明了但 switch 没分支), 会明确提示"需要更新模组"
```

同类物品会**合并计数**(`shulker_box x7(7组)`)，否则末影箱能列 49 行、太费 token。

---

## 许可证

本项目采用 **GNU Affero 通用公共许可证第 3 版（AGPL-3.0-or-later）** —— 全文见 [LICENSE](LICENSE)。

**一句话版**：你可以自由地使用、修改、分发它 ✓；但**如果你修改之后，通过计算机网络把它提供给别的人使用**
（例如架成 QQ 机器人 / 服务器 / 网站服务 ✗），你就必须**同样以 AGPL 公开你修改后的完整源码** ✓。

> 换句话说：**自己用、自己改** 随便 ✓；**改了还拿去对外提供服务**，改动就得开源 ✗。

本程序按"现状"发布，**不含任何担保** —— 尤其是它**会操作玩家物品/服务器设置**，
请自行评估风险并在测试服先验证 ✓。

版权人：`Yarra2000`（见源码头部 `Copyright (C)` 一行）


---

## 发布（维护者看这里）

打包**必须**用发布脚本，不要手工 zip：

```bash
node dev/make-release.js
# -> dist/<插件>-<版本>.zip
```

它会自动做完下面这些事，**任何一项不合格就报错退出、不留坏包**：

| # | 做什么 | 为什么（都是踩过的坑） |
|---|---|---|
| 1 | 用**干净配置**重新构建入口产物 | 部署用的 `ai_chat.js` 里**嵌了 API 密钥**，直接拿它打包 = **密钥泄漏** ✗ |
| 2 | 校验 **`manifest.json` 在 zip 根部** | 资源市场靠它自动识别；套一层文件夹就识别不到 ✗ |
| 3 | 校验 **`manifest.entry` 指向的文件真的在包里** | **真实事故**：入口被 `.gitignore` 排除，包里没入口，上传后**根本装不上** ✗✗ |
| 4 | 校验入口名与**构建产物名一致** | 名字对不上 = 装不上（反向测试专门验证过 ✓）|
| 5 | 扫描包内文本，**拒绝任何真实密钥**（`sk-` 长串 / Bearer / 令牌形态） | 密钥泄漏不可逆 ✗ |
| 6 | 排除 `dev/`、`CHANGELOG.md`、`.gitignore` | 不把开发资料分发给使用者 |

**可复现**：构建时间取自 **git 提交时间** ⇒ 同一个提交永远打出**同一个 md5** ✓（便于核对"这个包是不是这个版本"；可用 `SOURCE_DATE_EPOCH` 覆盖）

**部署 ≠ 发布**：部署用带密钥的那份（容器里那份），发布包永远是**干净版**（占位符 `sk-xxx`），使用者自己填 Key ✓


### 部署备忘（踩过的坑 ✗）

只 `docker cp ai_chat.js` **不够** —— `manifest.json` 也要一起拷，否则 WebUI 显示的版本/描述还是旧的 ✗

```bash
C=<容器ID>
docker cp ai_chat.js    $C:/app/appdata/plugins/easybot_ai_chat/ai_chat.js
docker cp manifest.json $C:/app/appdata/plugins/easybot_ai_chat/manifest.json   # ★ 别忘这个
docker restart $C
```
