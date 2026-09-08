export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function patchC6(chip) {
  if (chip?.CHIP_NAME !== 'ESP32-C6') return false;
  // esptool-js 0.6.1 compatibility: SPI1, as in esptool/targets/esp32c6.py.
  // SPI0 at 0x60002000 is the cache controller, not the command peripheral.
  chip.SPI_REG_BASE = 0x60003000;
  return true;
}

export function validateImages(images, capacity) {
  if (!images.length) throw new Error('请选择至少一个固件文件。');
  const sorted = [...images].sort((a, b) => a.address - b.address);
  let end = 0;
  for (const image of sorted) {
    if (!Number.isSafeInteger(image.address) || image.address < 0 || image.address % 4096)
      throw new Error('烧录地址必须是非负数，且按 0x1000 扇区对齐。');
    if (!image.data?.length) throw new Error('不能烧录空文件。');
    if (image.address < end) throw new Error('固件文件占用的 Flash 扇区重叠。');
    if (image.address + image.data.length > capacity) throw new Error('文件超出已检测到的 Flash 容量。');
    end = Math.ceil((image.address + image.data.length) / 4096) * 4096;
  }
  return sorted;
}

export function makeUsbReset(transport, {visible, log, delay = sleep, now = () => performance.now(), cancelled = () => false}) {
  const check = () => {
    if (cancelled()) throw new Error('连接已取消。');
    if (!visible()) throw new Error('页面进入后台：暂停复位，请切回前台重试。');
  };
  const wait = async () => {
    const start = now();
    await delay(100);
    const elapsed = now() - start;
    log('reset.wait', {requested: 100, elapsed: Math.round(elapsed)});
    check();
    if (elapsed > 350) throw new Error('浏览器调度延迟过大，已中止本轮复位。请保持网页在前台。');
  };
  const set = async (method, value) => {
    check(); log('reset.signal', {method, value});
    await transport[method](value);
  };
  return {async reset() {
    await set('setRTS', false); await set('setDTR', false); await wait();
    await set('setDTR', true); await set('setRTS', false); await wait();
    await set('setRTS', true); await set('setDTR', false); await set('setRTS', true); await wait();
    await set('setDTR', false); await set('setRTS', false);
  }};
}

// Recovery can resolve a fresh authorized SerialPort after re-enumeration.
// The application must disambiguate candidates and verify a pinned chip MAC.
export class Connection {
  constructor({create, close, visible, log, changed, delay = sleep, attempts = 4, resolvePort = async port => port}) {
    Object.assign(this, {create, close, visible, log, changed, delay, attempts, resolvePort});
    this.state = 'idle'; this.session = null; this.cancelled = false;
  }
  set(state) { this.state = state; this.changed(state); }
  async cleanup() {
    const session = this.session;
    if (!session) return;
    await this.close(session);
    this.session = null;
  }
  async connect(port, mode = 'usb_reset') {
    if (this.state === 'connecting' || this.state === 'ready' || this.session) throw new Error('请先断开当前连接。');
    this.cancelled = false; this.set('connecting');
    let last;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        if (this.cancelled) throw new Error('连接已取消。');
        if (!this.visible()) throw new Error('请将本网页切到前台，然后重新连接。');
        const attemptMode = Array.isArray(mode) ? mode[Math.min(attempt - 1, mode.length - 1)] : mode;
        this.log('connect.attempt', {attempt, mode: attemptMode});
        port = await this.resolvePort(port, attempt, () => this.cancelled);
        if (this.cancelled) throw new Error('连接已取消。');
        this.session = this.create(port, () => this.cancelled);
        const info = await this.session.start(attemptMode);
        if (this.cancelled) throw new Error('连接已取消。');
        this.set('ready'); return info;
      } catch (error) {
        last = error; this.log('connect.error', {attempt, name: error.name, message: error.message});
        try { await this.cleanup(); }
        catch (cleanupError) {
          this.set('error');
          throw new Error(`端口清理失败，请刷新页面后重新选择设备：${cleanupError.message}`);
        }
        if (this.cancelled || !this.visible() || error.name === 'DeviceMismatchError') break;
        if (attempt < this.attempts) await this.delay(500);
      }
    }
    this.set('idle'); throw last;
  }
  cancel() { this.cancelled = true; }
  async disconnect() {
    if (this.state === 'connecting') { this.cancel(); return; }
    this.set('disconnecting');
    try { await this.cleanup(); this.set('idle'); }
    catch (error) { this.set('error'); throw error; }
  }
}


export async function findAuthorizedPort({getPorts, matches, preferred, cancelled = () => false, delay = sleep, rounds = 80, allowReplacement = false}) {
  for (let i = 0; i < rounds; i++) {
    if (cancelled()) throw new Error('等待设备已取消，请保持页面在前台。');
    const ports = (await getPorts()).filter(matches);
    if (preferred) {
      if (ports.includes(preferred)) return preferred;
      if (allowReplacement && ports.length === 1) return ports[0];
      if (allowReplacement && ports.length > 1) throw new Error('存在多个已授权设备，请重新选择。');
    } else {
      if (ports.length === 1) return ports[0];
      if (ports.length > 1) throw new Error('存在多个已授权设备，请点击“连接设备”明确选择。');
    }
    if (i + 1 < rounds) await delay(100);
  }
  throw new Error('未找到可用的已授权设备。首次使用请点击“连接设备”；已授权设备请检查 USB 连接后重试。');
}
