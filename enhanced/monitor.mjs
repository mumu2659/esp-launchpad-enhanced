// Owns exactly one raw serial reader. Never sends bootloader commands or reset signals.
export class SerialMonitor {
  constructor({data,error,changed,stopTimeoutMs=3000}) {Object.assign(this,{data,error,changed,stopTimeoutMs});this.state='idle';this.port=null;this.reader=null;this.finished=null;}
  get active(){return this.state!=='idle';}
  set(state){this.state=state;this.changed(state);}
  async start(port,baudRate=115200){
    if(this.active || this.stopTask)throw Error('请先停止当前监听。');
    if(![9600,19200,38400,57600,115200,230400,460800,921600].includes(baudRate))throw Error('不支持的波特率。');
    this.lastError=null;this.set('opening');
    try {
      await port.open({baudRate,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:65536});
      this.port=port;this.reader=port.readable.getReader();this.set('listening');
      this.finished=this.readLoop().catch(error=>{this.lastError=error;this.error(error);this.set(this.port?'error':'idle');});
    } catch(error){
      if(this.port){try{await this.port.close();this.port=null;}catch{this.set('error');throw error;}}
      this.set('idle');throw error;
    }
  }
  pause(){if(this.state==='listening'){this.epoch=(this.epoch||0)+1;this.set('paused');}}
  resume(){if(this.state==='paused'){this.epoch=(this.epoch||0)+1;this.set('listening');}}
  async readLoop(){
    let decoder=new TextDecoder(), epoch=this.epoch;
    try {
      while(['listening','paused'].includes(this.state)){
        const {value,done}=await this.reader.read();
        if(done || !['listening','paused'].includes(this.state))break;
        if(epoch!==this.epoch){decoder=new TextDecoder();epoch=this.epoch;}
        if(this.state==='paused'){decoder=new TextDecoder();continue;}
        if(value)this.data(decoder.decode(value,{stream:true}));
      }
      const tail=decoder.decode();if(tail && this.state==='listening')this.data(tail);
    } catch(error){if(this.state!=='stopping'){this.lastError=error;this.error(error);}}
    finally {
      this.reader.releaseLock();this.reader=null;
      await this.port.close();this.port=null;this.set('idle');
    }
  }
  async stop(){
    if(this.state==='idle' && !this.stopTask)return;
    if(this.state==='opening')throw Error('串口正在打开，请稍候。');
    if(!this.stopTask){
      this.set('stopping');
      const work=this.stopWork();this.stopTask=work;
      const clear=()=>{if(this.stopTask===work)this.stopTask=null;};
      work.then(clear,clear);
    }
    let timer;
    try {
      await Promise.race([this.stopTask,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('串口尚未释放，请重试停止；若仍无响应，请刷新页面。')),this.stopTimeoutMs);
      })]);
    } catch(error){this.lastError=error;this.set('error');throw error;}
    finally{clearTimeout(timer);}
  }
  async stopWork(){
    if(this.reader)await this.reader.cancel();
    if(this.finished)await this.finished;
    if(this.port){await this.port.close();this.port=null;}
    this.set('idle');
  }

}

// Match esptool's normal EN pulse; this is not the USB download-mode sequence.
export async function restartDevice(port,{delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const info=port.getInfo();
  const native=info.usbVendorId===0x303a && info.usbProductId===0x1001;
  await port.setSignals({dataTerminalReady:false,requestToSend:true});
  try {await delay(native?200:100);}
  finally {await port.setSignals({dataTerminalReady:false,requestToSend:false});}
  if(native)await delay(200);
}
