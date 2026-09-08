# ESP Launchpad Enhanced

基于 [Espressif ESP Launchpad](https://github.com/espressif/esp-launchpad) 的非官方增强项目。
保留上游源码与 Apache-2.0 LICENSE；增强入口为 `enhanced.html`，原始入口仍为 `index.html`。

## 在线试用

使用桌面 Chrome / Edge 打开 [在线页面](https://mumu2659.github.io/esp-launchpad-enhanced/)。无需安装 Node.js。

设备反复掉线、无法首次授权时，下载 [USB 助手启动包](https://mumu2659.github.io/esp-launchpad-enhanced/downloads/esp-launchpad-enhanced-usb-helper.zip)，完整解压后 Windows 运行 start-windows.cmd，macOS 运行 start.command。首次准备环境需要联网，助手会打开本地连接页。后续可使用包内“打开助手.html”。

## 源码启动

需要 Node.js 20+ 和支持 Web Serial 的桌面 Chrome / Edge。

```sh
npm ci
npm start
```

打开 http://localhost:4173 。服务只监听本机，不需要 Python，也不依赖 CDN。
浏览器首次选择串口必须由用户操作并授权。固件在本地处理，不上传。

## 已实现

- 原生 USB Serial/JTAG 自动进入下载模式、已在下载模式时不复位、UART 自动下载电路三种连接模式。
- 前台检查，复位各阶段检测实际定时延迟；后台/严重延迟时终止本轮控制序列。
- 失败先取消读取并释放旧端口，重新获取重枚举后的已授权串口，最多 4 次；同一会话再次连接先尝试不复位，再回退 USB 下载复位。
- 只有握手、Flash ID 和容量检测成功才进入 ready；失败状态可重试，不吞异常。
- 对 esptool-js 0.6.1 的 ESP32-C6 SPI1 基址兼容修正：0x60002000 → 0x60003000。
- Web Serial 接收缓冲设为 64 KB；启动区读取校验并消费完整 MD5 尾帧。
- 启动区 4 KB 只读下载、多文件/合并镜像烧录、扇区重叠及容量检查、MD5 校验。
- 烧录必须选择文件和确认覆盖，写入失败不会自动重试；全片擦除需确认目标并输入 ERASE，失败不自动重试。
- 日志包含复位等待实际耗时、控制失败、USB 上下线及连接尝试，可导出 JSON。
- 增强界面不依赖 xterm，避免 Terminal 未加载导致全部按钮初始化失败。

## 范围与限制

烧录会覆盖文件涉及的完整 Flash 扇区。请使用目标芯片构建产物里的地址；工具不能替用户判断固件功能是否正确。
保持页面可见直到操作完成；不能绕过浏览器后台调度限制或系统 USB 权限。
首次使用点击“连接设备”；以后仍点击“连接设备”，避免在反复掉线时重复打开选择弹窗。
重枚举后可恢复唯一匹配的已授权端口；已识别过的芯片会核对 MAC，不一致即停止。多个候选端口需要明确选择；刷新页面会清除会话中的 MAC 记录。
成功后保持下载/stub 状态，不自动运行固件；复位或断电后需重新连接。
日志可能含 MAC 等设备标识，分享前可检查。原版入口保留上游行为；增强功能仅在增强入口。

## 验证

```sh
npm test
npm run test:browser
```

自动测试覆盖连接失败清理、重试、取消、后台定时器延迟、Flash 边界检查。
硬件验证记录见 `VALIDATION.md`。不要将模拟测试理解为实机烧录验证。

## 依据

- https://github.com/espressif/esptool/blob/master/esptool/targets/esp32c6.py
- https://github.com/espressif/esptool-js/blob/main/src/targets/esp32c6.ts
- https://docs.espressif.com/projects/esp-idf/en/stable/esp32c6/api-guides/usb-serial-jtag-console.html

发布前重新评估依赖版本；升级 esptool-js 后应检查 `patchC6()` 是否仍需要。
本项目不代表 Espressif 官方。上游 README 保存在 `README.upstream.md`。

## GitHub Pages 部署

`npm run build` 生成 `dist/`，其中只有增强页、运行库和许可证。
根入口是增强版；原版入口链接至官方 Launchpad。发布包不含 Flash 备份、诊断日志或仓库文件。

在 GitHub 仓库 Settings → Pages 中选择 GitHub Actions。
推送到 `main` 后，工作流先运行测试，通过后部署 `dist/`。
PR 只执行测试，不部署。

本地模拟仓库子目录部署：

```sh
npm run build
SITE_ROOT=dist BASE_PATH=/esp-launchpad-enhanced/ PORT=4174 npm start
# 另一个终端
BASE_URL=http://localhost:4174/esp-launchpad-enhanced/ npm run test:browser
```

浏览器测试在本地使用已安装的 Chrome；CI 使用 Playwright Chromium。

## 独立环境 USB 启动器

客户无需安装 Python、esptool 或 Node：下载启动包、完整解压后，Windows 双击 start-windows.cmd，macOS 双击 start.command，Linux 运行 sh start.command。入口自动识别系统/CPU，首次联网准备专用运行环境；之后复用缓存。

助手先通过原生 USB 尝试让 C6 进入下载模式，释放串口后打开包内网页（localhost:4175），预选“优先接管，失败自动恢复”连接。新站点仍需要客户在浏览器中首次点选设备授权。正常复位或断电后空 Flash 仍可能启动失败。

构建客户包：`npm run build:helper`，生成 `dist/downloads/esp-launchpad-enhanced-usb-helper.zip`；Pages 工作流使用该命令，网页中提供下载入口。详细使用、缓存位置和平台限制见 [USB 助手说明](usb-helper/README.md)。

开发自检：`sh usb-helper/start.command --doctor`；恢复逻辑测试：`sh usb-helper/start.command --self-test`。macOS/Windows 的首次系统运行确认不能由脚本跳过。

助手入口会检查当前站点已授权的 ESP USB 端口：唯一可用设备自动连接，未授权/未上线或多个候选时提示手动选择，不自行弹出首次授权窗口。只在进入页面时尝试一次；主动断开后不会自动抢回串口。环境检查发生在启动脚本阶段，独立于浏览器授权。烧录仍需要用户选择文件并确认。

网页确认芯片身份并缓存配套页面后，向助手发送接管确认，助手自动退出并释放本地服务端口。当前页面可继续读取/烧录，浏览器缓存有效时也可刷新；清理缓存后重新运行助手。终端可能保留已完成窗口，运行环境缓存不会自动删除。完整流程测试：`sh usb-helper/start.command --test-handoff`。


首次运行启动包会在当前用户目录注册网页唤起入口。之后助手网页的“连接设备”可先请求打开本地助手，恢复完成后再选择 USB；也提供直接授权入口。浏览器/系统的外部应用确认仍由用户完成。后台恢复与网页接管结束后全部助手进程退出，没有开机常驻服务。安装位置、日志、移除方法和平台验证范围见 USB 助手说明。

主界面统一使用“连接设备”；“启动 USB 恢复助手”和“设备已稳定，直接授权”位于默认折叠的“连接遇到问题？”中。


新增操作：

- 全片擦除：仅在下载连接就绪时可用，显示芯片、MAC 与容量，输入 ERASE 后清除全部 Flash。完成后保持下载模式；不修改 eFuse。
- 串口控制台：支持 9600–921600 波特率选项、开始/停止、更换串口、自动滚动、清空和导出。保留最近 20 万字符；UTF-8 流式解码，输出按纯文本显示。监听会释放烧录连接，不自动复位，不与烧录同时读取串口。
- 模组重启：确认后发送正常启动的 EN/RTS 复位序列，可选择继续监听。只报告重启信号是否发送，不将其等同于固件启动成功。原生 USB 重新枚举后监听可能停止，需要再次开始监听；USB 转串口需要自动复位电路。

控制台统一显示连接、烧录及模组串口输出，详细诊断默认折叠。如果固件将日志输出到 UART0，需要使用相应 USB 转串口设备；原生 USB 不保证包含 UART0 日志。新功能由模拟设备验证，尚未实机执行擦除或重启。

客户包新增“打开助手.html”：完成首次脚本运行后，可双击该入口通过按钮唤起助手。首次使用的系统入口及拖放文件生成完整路径的方法也在页面内说明。

控制台无需开始监听即可看到连接和烧录日志；“开始监听”用于切换到模组原始串口输出。清空与导出作用于当前控制台保留的全部输出。
