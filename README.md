# ESP Launchpad Enhanced

An independent, unofficial enhancement of [Espressif ESP Launchpad](https://github.com/espressif/esp-launchpad), focused on ESP32-C6 native USB recovery, firmware flashing, and serial monitoring.

The upstream source and Apache-2.0 license are retained. The enhanced source entry is `enhanced.html`; the original entry remains `index.html`. See [the upstream README](README.upstream.md) and [LICENSE](LICENSE) for attribution. This project is not an official Espressif product.

## Try it online

Open the **[web tool](https://mumu2659.github.io/esp-launchpad-enhanced/)** in desktop Chrome or Edge. The tool interface is currently in Chinese. Firmware is processed locally and is not uploaded.

If a blank device repeatedly disconnects before you can authorize it, download the **[USB helper package](https://mumu2659.github.io/esp-launchpad-enhanced/downloads/esp-launchpad-enhanced-usb-helper.zip)** and extract it completely.

| Platform | Launch |
| --- | --- |
| Windows | Double-click `start-windows.cmd` |
| macOS | Double-click `start.command` |
| Linux | Run `sh start.command` |

No preinstalled Python, esptool, or Node.js is required for the helper. Its first launch requires internet access to prepare a dedicated environment; subsequent launches reuse the cache.

The helper attempts to put the ESP32-C6 into download mode through native USB, releases the serial port, and opens the bundled local page at `http://localhost:4175`. First-time browser device authorization still requires a manual selection. The helper does not write or erase Flash or change eFuses.

## Features

- Native USB Serial/JTAG download reset, connection without reset, and UART automatic-reset modes.
- Connection retries with serial-port cleanup, cancellation, device re-enumeration handling, and MAC identity checks.
- Chip, Flash ID, and capacity detection before marking a connection ready.
- Read-only download of the first 4 KB of Flash.
- Flash multiple images or a merged image, with address, sector-overlap, capacity, and MD5 checks.
- Full-chip erase with target details and an explicit `ERASE` confirmation.
- A shared console for connection, flashing, and raw serial output, with baud-rate selection, start/stop, port selection, auto-scroll, clear, and export.
- Module reset with confirmation and optional serial monitoring.
- An optional local USB recovery helper with browser handoff and automatic exit.

The interface uses a single connect/disconnect control and a single start/stop monitoring control. Recovery options and detailed diagnostics are collapsed by default.

## USB helper behavior

The launcher detects the system and CPU architecture, prepares its environment, and registers a per-user browser launch entry. Browser and operating-system prompts still require user approval; a website cannot silently install or launch local software.

On the helper page, a single available, previously authorized ESP USB device can connect automatically. Otherwise, the page requests manual selection. It attempts automatic connection once on entry and does not reclaim a port after an intentional disconnect.

After the page verifies the chip identity and caches its assets, it acknowledges the handoff. The helper then exits and releases its local server port. Reading and flashing can continue, and refresh works while the browser cache remains available. Run the helper again if that cache has been cleared.

There is no startup service. Environment caches remain for reuse, and a completed terminal window may remain open. After initial setup, the HTML launcher included in the package can also request recovery.

See the [USB helper guide](usb-helper/README.md) for installation locations, logs, removal, and platform limitations. That detailed guide is currently in Chinese.

## Console, erase, and reset

Connection and flashing logs appear without starting serial monitoring. Starting monitoring releases the flashing connection and reads raw serial output without an automatic reset. Monitoring and flashing do not read the port concurrently.

The console supports baud rates from 9600 to 921600, streaming UTF-8 decoding, and plain-text output. It retains the latest 200,000 characters. Clear and export apply to all retained console output.

Full-chip erase is available only when the download connection is ready. It displays the chip, MAC, and capacity before confirmation, keeps the device in download mode afterward, and does not modify eFuses. Failed writes and erases are not automatically retried.

Module reset sends the normal-boot EN/RTS reset sequence. Successful signal delivery does not prove that firmware booted successfully. Native USB re-enumeration may interrupt monitoring; start monitoring again if needed. USB-to-UART adapters require a suitable automatic-reset circuit.

If firmware logs are routed to UART0, use the corresponding USB-to-UART connection. Native USB does not necessarily carry UART0 logs.

## Run from source

Requires Node.js 20 or later and a desktop browser with Web Serial support.

```sh
npm ci
npm start
```

Open `http://localhost:4173`. The development server listens only on the local machine. The web interface does not require Python or runtime CDN requests.

## Validation

```sh
npm test
npm run test:browser
```

Helper checks:

```sh
sh usb-helper/start.command --doctor
sh usb-helper/start.command --self-test
sh usb-helper/start.command --test-handoff
```

Automated tests cover connection cleanup, retries, cancellation, delayed background timers, Flash boundaries, device controls, and helper handoff. Helper environment tests run on Windows, macOS, and Linux. Local browser tests use installed Chrome; CI uses Playwright Chromium.

See [VALIDATION.md](VALIDATION.md) for detailed hardware evidence and limitations; this record is currently in Chinese. Simulated tests are not proof of physical-device flashing. Erase and reset controls have been tested with simulated devices, not by performing these operations on hardware.

## Build and deploy

```sh
npm run build:helper
```

This builds the enhanced website and creates `dist/downloads/esp-launchpad-enhanced-usb-helper.zip`, including its scripts and bundled web page. The runtime environment is downloaded on first use.

`npm run build` builds the website alone into `dist/`. The deployed root opens the enhanced interface, and the original Launchpad link points to the official site. Published assets exclude Flash backups, diagnostic logs, and repository metadata.

In GitHub **Settings → Pages**, select **GitHub Actions**. Pushes to `main` run tests and deploy on success. Pull requests run validation without deployment.

To test a repository subpath locally:

```sh
npm run build
SITE_ROOT=dist BASE_PATH=/esp-launchpad-enhanced/ PORT=4174 npm start
```

In another terminal:

```sh
BASE_URL=http://localhost:4174/esp-launchpad-enhanced/ npm run test:browser
```

## Scope and limitations

Flashing overwrites the complete Flash sectors covered by the selected files. Use addresses from the firmware build for the target chip. The tool cannot determine whether a selected firmware image is functionally correct.

Keep the page visible until an operation finishes. Browser background scheduling and operating-system USB permissions still apply. Reset sequences are aborted when timing is substantially delayed.

After re-enumeration, recovery requires a uniquely matching authorized device. A known chip's MAC must match; multiple candidates require explicit selection. Reloading the page clears the session's MAC record.

A successful connection leaves the chip in download or stub mode rather than automatically running firmware. Resetting or power-cycling a blank chip can still cause boot failure and repeated disconnections. The helper stabilizes the current download session; it does not install boot firmware.

Logs can contain device identifiers such as MAC addresses. Review them before sharing.

## Implementation references

The enhanced interface includes an ESP32-C6 SPI1 base-address compatibility correction for esptool-js 0.6.1, a 64 KB Web Serial receive buffer, and complete MD5 trailer handling for Flash reads. It does not depend on xterm.

- [Python esptool ESP32-C6 target](https://github.com/espressif/esptool/blob/master/esptool/targets/esp32c6.py)
- [esptool-js ESP32-C6 target](https://github.com/espressif/esptool-js/blob/main/src/targets/esp32c6.ts)
- [ESP32-C6 USB Serial/JTAG documentation](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c6/api-guides/usb-serial-jtag-console.html)

Reassess dependency versions before releases and review whether `patchC6()` is still needed after upgrading esptool-js.
