# M2：BOSS 专用浏览器与百度地图

2026-10-27 · dsh-boss 0.2.4 · DSH 0.2.1-rc.2 · 本轮 macOS 验收

原生 DSH 对话保持主界面，右侧「我的求职」承接搜索、保存、补充、跟进和地图。AI 经本地 MCP 写入相同 SQLite，人工字段保护、候选冲突、版本校验及撤销继续生效。保存机会不会投递或联系招聘方；插件没有开放任何平台写操作。

## 为什么调整 BOSS 连接

用户在 0.2.1 内扫码成功后，真实搜索先发现旧适配器的 `stored-cookie` 模式缺少显式 CDP；临时浏览器方案的一次真实请求又返回官方环境限制 code 37。本轮不把这些错误当作零岗位。

按用户指定检查 [BossHunter 上手指南](https://github.com/shengjidaguai-china/BossHunter/blob/main/docs/QUICKSTART.md)、[浏览器会话](https://github.com/shengjidaguai-china/BossHunter/blob/main/src/bosshunter/browser/session.py) 与 [BOSS collector](https://github.com/shengjidaguai-china/BossHunter/blob/main/src/bosshunter/collection/platforms/boss.py)，采纳两点：

1. 登录和采集始终使用同一个专用 Chrome profile，保持浏览器开启。
2. 导航官方岗位页，读取页面岗位卡片和详情；验证码、限制、未知结构停止，不自动换通道。

本项目独立实现只读适配器，没有复制 BossHunter 的任务调度、评分、沟通、投递功能。BossHunter 源项目采用 PolyForm Noncommercial，不能把它当作不受限制的商业代码依赖。

调用链为：DSH 领域工具 → 私有进程内 MCP → DiscoveryService → 固定 Python 原生 CDP DOM reader → 专用 Chrome。人工 UI 经 owner RPC 调用相同业务服务。Python 只接受 `boss_status/boss_search/boss_detail`，严格校验输入；数据只回传岗位字段。没有调用私有招聘 API、复制 Cookie、修改浏览器指纹或自动处理验证码。

搜索一页一个请求，最多 10 次加载，按岗位 ID 合并；未知结构、未加载出下一批、缺失标题/公司均明确报错并保留已有结果。字体私用字符导致不能可靠读取的薪资留空，不猜数字。每次读取至少相隔 3 秒，每个本地数据目录每天最多 60 次搜索/详情请求。登录和读取有进程间互斥。

## 登录与验证

右侧「连接 BOSS 直聘」显示官方二维码，搜索、详情、保存、补充和地图在插件内操作。默认不再展示打开新网页的按钮；仅在折叠的连接帮助/受阻说明中提供「显示已有会话窗口」。扫码后在手机确认，不需要 DeepSeek Key、BOSS Key 或复制 Cookie；AI 对话的模型配置仍由 DSH 管理。

Chrome profile 位于 `.local/boss/chrome-profile/`，目录权限 0700，使用仅本机监听的随机调试端口。适配器仅发现这个专用目录的端口，并核对 browser ID，防止陈旧端口误连其他浏览器；不探测或读取日常 Chrome profile。浏览器由用户保持开启，插件卸载只断开连接、结束读取和二维码采集，保留专用窗口与登录。旧 `auth/session.enc` 保留但不再用于注入新浏览器。

二维码只进入 owner UI 的短期内存，过期、取消或连接失联后清除；不写入数据库、聊天和日志。模型没有打开浏览器、开始扫码或恢复受限状态的工具。

若曾遇到官方限制，重启仍保留停止状态。搜索安全检查单独显示「搜索已暂停」，避免与扫码登录失效混淆；禁用在线搜索、加载下一批及未缓存详情，本地保存、补充和地图仍可使用。用户在同一会话处理官方验证并确认手动搜索已可用后，勾选确认并点击「确认后恢复搜索」，才归档本地停止记录并检查会话。这不代表服务器限制已解除；再次收到限制会重新停止。普通刷新、检查状态及模型调用不能清除停止记录。

## 0.2.4：首页跳转诊断与单标签页

2026-10-27 在已登录的专用会话中复用现有标签，观测到：

```text
/web/geek/job                HTTP 200
/web/geek/jobs              当前网站内部路由
/wapi/zpgeek/search/joblist.json  HTTP 200（不等于业务成功）
/web/passport/zp/security.html
/web/geek/jobs ↔ /web/passport/zp/security.html
/                          最终官网首页
```

用户同日在同一窗口手动搜索「西安 · AI 平台」，反馈“闪烁一下自动返回主页面”。这证明失败也发生在官网手动搜索中；不能仅靠修改插件搜索链接解决。此处没有取得并保留本次 joblist 的业务码，不能把旧临时会话的 code 37 当作本次证据，也不能认定账号被封。

旧 DOM 检查遗漏了 `security.html` 路径，且短暂跳转发生在 DOM 轮询之间；页面最后回到首页后仅报重定向。现在同时检查 CDP 文档导航事件与当前 DOM，首次发现官方安全检查即返回受控错误 `BOSS_SECURITY_CHECK` 并持久化停止状态。诊断仅留公开路径、阶段和受控错误码，不保存查询令牌、请求头、Cookie 或响应正文。状态轮询不会覆盖上次失败证据。

`browser-target` 只保存本专用 profile 的工作标签 ID，权限 0600。扫码、搜索、详情共享该标签；即使上次退回首页，下次操作也复用，不再创建重复主页。标签关闭后只从本 profile 的 BOSS/空白页选择；全部关闭时才创建一个后台工作标签。显式验证按钮只唤起已有会话，不再通过重新启动 Chrome 携带 URL 的方式添加页面。不会操作日常 Chrome。

搜索结果返回前核对当前 URL 的城市和关键词；被网站改成北京或推荐列表时明确报错，不能标成西安岗位。正常业务入口可收拢在插件内，但官方安全检查仍需网站允许当前会话；当前未实现把完整官网或验证码操作嵌入插件，不承诺验证也能完全闭环。

## 百度免 Key 地图

默认嵌入 [百度官方 URI 地图](https://lbsyun.baidu.com/docs/webapi?title=mapadjustment/uri/web)，支持城市/地址搜索和位置标记，并提供「在百度地图中查看」入口。无需 AK，未借用示例 Key、私有瓦片或签名接口。免 Key 页面保留百度原生搜索栏和推广内容，无法达到自有 SDK 地图的简洁程度。

实测官方 URI 的 `coord_type=wgs84/gcj02` 会跳转成错误坐标 `-71.988531,360`。因此使用 MIT 的 [coordtransform 2.1.2](https://github.com/wandergis/coordtransform) 在本地把 WGS84 转换成 BD09，仅用于地图展示，再明确传 `coord_type=bd09ll`；存储的权威坐标仍是 WGS84。该近似转换用于地点查看，不用于测绘。

百度免 Key 页面不会把点击坐标回传插件。点「查找可保存的位置」由 Photon 提供候选，选中后预览；「手动标记位置」打开 OSM 坐标编辑器。本人核对后选择具体办公点或大致区域并确认，才写入坐标。城市/地址改变立即使旧点失效，撤销有版本和 ABA 校验。地址候选不会自动等同于公司总部或岗位办公点。

[Photon 公共实例](https://github.com/komoot/photon#demo-server)无可用性保证，国内覆盖可能不完整。查询仅发送城市和地址，不发送私人备注或简历；最小请求间隔 1.1 秒，缓存 7 天。可用 `DSH_BOSS_PHOTON_URL` 配置自己的 HTTPS 实例。OSM 编辑器保留版权署名，遵守[瓦片政策](https://operations.osmfoundation.org/policies/tiles/)。未实现通勤估时、用户定位、路线规划或百度点击点位回传；后续完整百度交互需要申请开发者 AK。

## 安装与启动

本轮依赖：macOS、Google Chrome、Node 22.13+、Python 3.12、uv、DSH 0.2.1-rc.2。Python 仍固定 `boss-agent-cli[mcp]==3.0.1`，复用其城市字典、官方错误识别与登录页校验；原外部 BOSS MCP 执行通道已经替换为专用 DOM reader。

```sh
npm ci
npm run boss:setup
npm run check
.runtime/bin/python -m unittest discover -s tests -p 'test_*.py'
npm pack --pack-destination artifacts
dsh plugin --profile web add /absolute/path/dsh-boss-0.2.4.tgz
npm start
```

`npm start` 将运行组件与数据目录路径登记到 `$DSH_HOME/dsh-boss/connection.json`（0600，不含凭据），后续 `dsh web` 可直接连接。移动仓库后重新运行 `npm start`。`npm run boss:login` 也只打开同一专用 Chrome，不再启动另一个临时会话。

```sh
export DSH_BOSS_MCP_BIN=/absolute/path/dsh-boss/.runtime/bin/boss-mcp
export DSH_BOSS_DATA_DIR=/absolute/path/dsh-boss/.local/boss
dsh web
```

独立验收使用单独 `DSH_HOME` 和 `DSH_BOSS_DATA_DIR`，不复制全局账号、浏览器会话或求职资料。

## 数据与工具

- `state.sqlite` 保存机会、个人资料、字段来源、人工保护、修改记录和候选；请求 ID 幂等，版本 CAS。M1 v1 → v2 前做一致性备份，历史记录不回填假坐标。
- `discovery.sqlite` 保存最后成功结果、岗位快照及地点缓存。只有实际已获取的岗位才能导入，按平台岗位 ID 去重；人工补充不被重复保存覆盖。
- `career_search_jobs/career_job_detail/career_save_job/career_locate_address` 继续经本地 MCP 服务；地点确认、扫码和受限恢复仅限 owner UI。
- 前端不展示日志、Cookie、调试端点、原始上游响应；错误使用受控文案。网页内容只是数据，不授予工具权限。

## 验收记录

已通过：37 项 TypeScript 测试、12 项 Python 测试、类型检查与双端构建。包含宿主 owner 权限、私有 MCP 读写、来源导入与去重、人工字段保护、冲突候选、撤销、取消、风险状态保持、显式恢复、跨进程互斥、地址失效、百度坐标转换及参数编码。

此前全局 DSH 已实际加载百度地图，显示西安市底图；隔离环境已实际完成保存机会、查询「西安软件新城」地址候选、BD09 地图标点、确认大致区域、修改地址使旧点失效、撤销地址修改后重新确认位置；重启后记录保留。本人已在插件完成扫码，搜索诊断前可见官网登录状态。

本轮真实搜索失败原因已经定位到上述官方安全检查循环，用户手动搜索也复现，已暂停重复搜索并保留登录记录。随后只读检查时专用 Chrome 已无任何页面，本轮没有为了验收重新打开 BOSS 页面。单标签复用、回首页后复用、关闭后恢复、城市被替换、安全检查瞬间跳转和重启保持停止状态均有自动化回归覆盖。

**真实搜索、真实岗位详情/导入与真实公司定位仍未验收通过。** 不能用模拟数据、公开搜索引擎结果或本地记录测试冒充真实 BOSS 搜索闭环。

测试记录使用「非真实招聘」名称并仅保存在隔离验收目录。未提交或推送代码；没有真实投递、打招呼或平台消息。
