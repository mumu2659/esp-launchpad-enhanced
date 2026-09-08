export const RECOVERY_URL = 'esp-launchpad-enhanced://recover';
export function createLauncher({fetcher=fetch,navigate=url=>{location.href=url;},status,log=()=>{}}) {
  let state='unknown', checking, generation=0;
  return {
    get state(){return state;},
    invalidate(){generation++;state='offline';},
    async refresh(){
      if(checking)return checking;
      const started=generation;
      checking=(async()=>{
        try {
          const response=await fetcher('./__helper__/session',{headers:{'X-Launchpad-Client':'1'},cache:'no-store',signal:AbortSignal.timeout(1500)});
          if(!response.ok)throw Error('No helper');
          const data=await response.json();
          if(typeof data.token!=='string')throw Error('Invalid helper');
          if(started===generation)state=data.ready?'ready':'busy';
        } catch {if(started===generation)state='offline';}
        finally {checking=null;}
        return state;
      })();
      return checking;
    },
    launch(){
      // Must run directly in the click handler, never on page load or a timer.
      status('请在浏览器提示中允许打开 USB 助手。恢复完成会打开连接页面，再点击选择 USB。若没有反应，请先运行解压目录的启动脚本一次。');
      log('helper.launch-requested');
      navigate(RECOVERY_URL);
    }
  };
}
