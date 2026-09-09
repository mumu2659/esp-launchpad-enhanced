# ESP Launchpad Enhanced USB 助手

无需预装 Python、esptool 或 Node.js。首次启动需要联网下载独立运行环境，以后复用缓存。

## 客户使用

已运行过本包：双击同目录的“打开助手.html”，点击“启动 USB 助手”，无需输入终端路径。首次使用按下面步骤运行一次启动脚本。

1. 完整解压启动包，不要直接从压缩包里运行。
2. Windows 双击 `start-windows.cmd`；macOS 双击 `start.command`；Linux 在终端执行 `sh start.command`。
3. 关闭其他串口工具或断开网页连接，接上 ESP32-C6 的原生 USB。
4. 助手自动识别系统/架构，准备环境并注册当前用户的网页唤起入口，尝试稳定下载模式；存在多个 ESP USB 设备时会要求输入序号。
5. 成功后打开配套本地网页。已有且仅有一个 ESP USB 授权设备时自动连接；首次或存在多个设备时点击“连接设备”。此时网页已选择“优先接管，失败自动恢复”连接。网页识别芯片并准备好离线页面后，确认接管，助手自动退出。
6. 助手退出后可继续读取和烧录；终端窗口可能保留“进程已完成”，可直接关闭。

首次仍需浏览器设备授权。助手只运行 `flash-id`（可能上传 RAM stub），没有 Flash 写入/擦除或 eFuse 操作。
空 Flash 在正常复位后仍可能启动失败；助手保持的是当前下载状态，不是写入启动固件。

macOS 下载文件可能需要在系统提示中确认允许打开；若解压工具未保留执行权限，可在终端执行 `sh ` 后拖入 `start.command` 并回车。
Windows 使用进程级 PowerShell 执行策略，不修改机器策略；企业策略可能仍阻止运行。
Linux 需要 curl、tar、SHA256 工具和串口访问权限；不自动安装驱动或提升权限。

## 支持范围

- 入口适配：Windows x64/ARM64，macOS Intel/Apple Silicon，Linux glibc x64/ARM64。
- 架构由脚本自动识别；Windows 与 Unix 仍使用不同的双击入口，因为系统脚本格式不同。
- 已确认固定 Python 下载清单提供这六种系统/架构组合；实际测试范围见项目 VALIDATION.md，未测试的平台不宣称已验证。
- 目前只针对 ESP32-C6 原生 USB Serial/JTAG（VID 303a / PID 1001）；USB 转 UART 不自动操作。
- 若设备身份缺少序列号/位置、重枚举后路径也变化，助手停止等待，不猜测另一块设备。
- 浏览器优先 Chrome/Edge；默认浏览器不支持 Web Serial 时手动复制地址到 Chrome/Edge。

## 独立环境与下载来源

固定 uv 0.12.10、Python 3.12.12、esptool 5.4.0；uv 发布包通过内置 SHA256 清单验证，Python 由 uv 管理，Python 包按 requirements.lock 的固定版本及哈希安装。

- uv：https://github.com/astral-sh/uv/releases/tag/0.12.10
- 独立 Python：https://docs.astral.sh/uv/guides/install-python/
- Python 包：https://pypi.org/simple

缓存：Windows `%LOCALAPPDATA%\ESP-Launchpad-Enhanced`，macOS `~/Library/Caches/esp-launchpad-enhanced`，Linux `${XDG_CACHE_HOME:-~/.cache}/esp-launchpad-enhanced`。
不修改 PATH 或系统 Python，不安装浏览器扩展或开机常驻服务。Windows 会写入当前用户的专用 URL 协议项，不修改全机设置。退出助手后可删除上述专用缓存卸载运行环境；网页唤起入口的位置见下文。
首次需能访问 GitHub 和 PyPI；首次下载失败会显示原因，重试会复用有效缓存。本包不是完全离线安装包。

## 开发与诊断

- `sh usb-helper/start.command --doctor`：仅准备并检查独立环境，不打开 USB。
- `sh usb-helper/start.command --prepare-only`：仅稳定 USB。
- `sh usb-helper/start.command --site-dir dist`：源码目录运行完整流程（先构建网页）。
- `sh usb-helper/start.command --serve-only --site-dir dist`：仅验证网页服务。
- Windows 同样可以向 start-windows.cmd 传入这些参数。
- `LAUNCHPAD_HELPER_CACHE` 可指定隔离测试缓存。

默认服务只监听 127.0.0.1:4175，固定端口方便浏览器复用站点授权；新实例会核对本机实例凭据，请已就绪的旧助手正常退出后接管端口；旧助手正在恢复 USB 时保留当前操作，提示稍后重试。
其他程序或不支持身份验证的旧版助手占用端口时不会自动关闭，需要手动处理一次。不会按端口号或 PID 强杀进程。
控制凭据保存在上述默认缓存目录的 instances 子目录中（与运行环境缓存位置覆盖无关）。实例替换接口仅接受本机凭据，拒绝浏览器 Origin 请求。网页接管接口另用同源会话令牌，检查芯片信息与已知 MAC；未连接、缓存失败或身份不符时不会自动退出。不提供通用本地命令执行接口。

开发环境打包：`npm run build:helper`。产物位于 `dist/downloads/esp-launchpad-enhanced-usb-helper.zip`，内含网页和脚本，运行环境在首次启动时下载。

网页接管前会在浏览器缓存配套页面，因此助手退出后仍可刷新。浏览器清理或回收缓存后需重新运行助手；独立 Python 环境缓存仍可复用。首次授权仍需点击选择设备，网页不能静默安装或启动本地脚本。

完整接管回归：`sh usb-helper/start.command --test-handoff`（开发环境，需 Node 和 Playwright 浏览器）。

## 换模组后从网页启动

首次完整运行启动包后，当前用户注册 esp-launchpad-enhanced://recover。以后在助手网页点击“连接设备”：助手未运行时请求系统打开助手，忙碌时等待，就绪时打开 USB 选择器。已有稳定设备也可点击“设备已稳定，直接授权”。其他页面提供“启动 USB 恢复助手”入口。

浏览器可能要求确认打开外部应用；首次 USB 授权也需要点击选择，不能静默代替。若点击没有反应，先运行解压目录里的启动脚本一次，再回到网页重试。网页只能判断助手服务是否在线，不能可靠区分“尚未注册”和“用户取消打开”。

后台助手只执行固定的 USB 恢复流程，不接收网页指定的命令、固件路径或返回网址。恢复完成打开本地页面；页面已授权唯一设备时自动连接，否则等待点击授权。接管成功后助手和唤起进程自动退出。重复点击由系统文件锁拦截，多块设备时后台模式停止并提示仅连接目标模组。

安装位置（网页副本和唤起入口独立于解压目录，移动解压目录不影响已安装入口）：

- macOS：~/Library/Application Support/ESP Launchpad Enhanced/，其中生成小型 AppleScript 应用并注册 URL scheme。
- Windows：%LOCALAPPDATA%/ESP-Launchpad-Enhanced/launcher/；协议项为 HKCU/Software/Classes/esp-launchpad-enhanced，使用独立环境的 pythonw.exe。
- Linux：${XDG_DATA_HOME:-~/.local/share}/esp-launchpad-enhanced/；另有 applications/io.github.esp-launchpad-enhanced.usb-helper.desktop，使用 xdg-mime 注册。

恢复失败提示中会给出上述目录中的 launcher.log。后台模式需要原有独立环境缓存仍在；删除环境后请重新运行启动脚本。不会自动删除缓存或强制关闭用户的终端窗口。

开发选项：--register-launcher 仅注册入口（启动包需包含 site）；--no-register 跳过本次注册，保持手动运行。--doctor、--self-test、--test-handoff、--serve-only、--prepare-only 不自动注册。

移除入口：macOS 删除上述专用目录中的应用；Windows 删除上述专用协议项；Linux 删除对应 desktop 文件及用户 mimeapps.list 中该协议的关联。确认助手退出后，可删除专用安装目录与运行环境缓存。入口属于当前用户，不需要管理员权限。

macOS 网页唤起与实机接管已验证；Windows/Linux 已实现入口与自动测试，尚未进行系统协议唤起实测。

主界面统一使用“连接设备”；“启动 USB 恢复助手”和“设备已稳定，直接授权”位于默认折叠的“连接遇到问题？”中。

配套网页新增全片擦除（输入 ERASE 确认）、串口输出监听/导出和模组重启（确认后可监听输出）。这些操作均由用户在网页触发；后台助手仍只读取芯片信息，不执行擦除或写入。监听会释放烧录连接，暂停监听保持连接并丢弃暂停期间的数据；点击“断开”释放串口，之后重新连接即可烧录。USB 在重启时重新枚举可能中断监听，请再次开始监听。

控制台无需开始监听即可看到连接和烧录日志；“开始监听”用于切换到模组原始串口输出。清空与导出作用于当前控制台保留的全部输出。

更换串口直接打开浏览器设备列表，默认显示原生 USB 和支持的 USB 转串口适配器。高级选项可显示全部端口。UART0 / UART1 由实际接线区分。

多路控制台：USB、UART0、UART1 分别选择端口与断开。默认显示已连接通道，取消来源勾选仅隐藏显示，仍缓存数据；重新勾选恢复缓存输出。暂停对全部监听通道生效，保持连接但丢弃暂停数据。工具日志始终显示；导出遵循来源筛选，清空删除全部缓存。日志时间为 UTC 接收时间。UART 标记需按接线指定，不代表自动验证模组身份。下载连接只接管同一端口，其他通道继续监听。

原生 USB 不显示波特率；UART0、UART1 各自在未连接时设置波特率。重启确认框显示最近打开的监听通道（该通道未打开时使用下载连接）。
