// Install and migrate in a disposable home; launchctl, Dock and app activation are isolated.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'badge-install-'));
const installDir=path.join(temp,'Library/Application Support/CodexUsageBadge');
const shortcut=path.join(temp,'Desktop/Codex 用量条.app'),launcher=path.join(temp,'Applications/Codex 用量条.app');
const jobs=new Set(),messages=[],calls=[];
let failJob='',failCopy=false;
const testFs={...fs,copyFileSync(source,dest,...args){if(failCopy&&dest===path.join(installDir,'startup-helper/bridge')){failCopy=false;throw Error('simulated helper write failure');}return fs.copyFileSync(source,dest,...args);}};
const execFileSync=(bin,args,options)=>{
  calls.push([bin,...args]);
  if(bin==='/bin/launchctl'){
    const job=args[0]==='bootstrap'?path.basename(args[2],'.plist'):args[1].split('/').at(-1);
    if(args[0]==='print'){if(jobs.has(job))return 'state = running';throw Error('not loaded');}
    if(args[0]==='bootout'){jobs.delete(job);return '';}
    if(args[0]==='bootstrap'){
      if(failJob===job){failJob='';throw Error('simulated bootstrap failure');}
      assert.ok(fs.existsSync(args[2]));jobs.add(job);
      if(job==='com.codexusagebadge.startup'){
        const receipt=path.join(installDir,'startup-helper/state.json');let old={};try{old=JSON.parse(fs.readFileSync(receipt,'utf8'));}catch{}
        fs.writeFileSync(receipt,JSON.stringify({...old,event:'watching',updatedAt:Date.now()}));
      }
      return '';
    }
    throw Error('unexpected launchctl action');
  }
  if(bin.endsWith('/bridge')||bin.endsWith('/macos-startup-bridge'))return args[0]==='restore-dock'?JSON.stringify({ok:true,changed:false}):JSON.stringify({apps:[]});
  if(bin==='/usr/bin/getconf')return path.join(temp,'runtime');
  if(bin.endsWith('/lsregister')||bin==='/usr/bin/killall')return '';
  assert.ok(!['/usr/bin/open','/usr/bin/osascript'].includes(bin),'installation must not activate or quit the client');
  return cp.execFileSync(bin,args,options);
};
class FailedSocket{constructor(){this.events={};setImmediate(()=>this.events.error?.());}addEventListener(n,h){this.events[n]=h;}close(){}}
const sandbox={module:{exports:{}},__dirname:root,process,Buffer,URL,setTimeout,clearTimeout,AbortSignal,WebSocket:FailedSocket,
  console:{log:s=>messages.push(s),warn:s=>messages.push(s)},fetch:async()=>({ok:true,json:async()=>[{type:'page',url:'app://-/index.html',webSocketDebuggerUrl:'ws://127.0.0.1/unreachable'}]}),
  require:id=>id==='node:fs'?testFs:id==='node:os'?{...os,homedir:()=>temp}:id==='node:child_process'?{...cp,execFileSync}:id==='./agent.cjs'?require('../agent.cjs'):id==='./macos/shortcuts.cjs'?require('../macos/shortcuts.cjs'):id==='./updater/core.cjs'?require('../updater/core.cjs'):require(id)};
vm.runInNewContext(fs.readFileSync(path.join(root,'manage.cjs'),'utf8'),sandbox,{filename:'manage.cjs'});
const manager=sandbox.module.exports;
(async()=>{try{
  fs.mkdirSync(path.join(temp,'Desktop'),{recursive:true});
  failCopy=true;await assert.rejects(manager.install(),/已恢复安装前的程序文件/);
  assert.equal(jobs.size,0);assert.equal(fs.existsSync(installDir),false);
  failJob='com.codexusagebadge.updater';await assert.rejects(manager.install(),/已恢复安装前的程序文件/);
  assert.equal(jobs.size,0);assert.equal(fs.existsSync(installDir),false);
  await manager.install();await manager.install();
  assert.equal(jobs.size,3);assert.equal(fs.existsSync(launcher),false);assert.equal(fs.existsSync(shortcut),false);
  const settings=path.join(installDir,'update-settings.json');fs.writeFileSync(settings,JSON.stringify({owner:'codex-usage-badge-updater-v1',enabled:false}));
  await manager.install();assert.equal(JSON.parse(fs.readFileSync(settings,'utf8')).enabled,false,'upgrade must retain opt-out');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir,'installed-version.json'),'utf8')).version,require('../package.json').version);
  assert.equal(manager.updaterConfig().StartInterval,21600);
  // An updater's child installer must leave its launchd parent alive until it returns.
  const installedVersion=path.join(installDir,'installed-version.json');
  const oldVersion=JSON.parse(fs.readFileSync(installedVersion,'utf8'));fs.writeFileSync(installedVersion,JSON.stringify({...oldVersion,version:'0.9.3'}));
  fs.writeFileSync(settings,JSON.stringify({owner:'codex-usage-badge-updater-v1',enabled:true}));
  const callStart=calls.length;process.argv.push('--from-update');
  try{
    await manager.install();assert.equal(jobs.size,3);
    assert.ok(!calls.slice(callStart).some(c=>c[0]==='/bin/launchctl'&&c[1]==='bootout'&&c[2].endsWith('/com.codexusagebadge.updater')),'self-update must not kill the waiting updater');
    assert.ok(!calls.slice(callStart).some(c=>c[0]==='/bin/launchctl'&&c[1]==='bootstrap'&&c[3].endsWith('com.codexusagebadge.updater.plist')),'self-update reuses the loaded periodic task');
    const afterUpdate=calls.length;await manager.install();assert.equal(calls.length,afterUpdate,'same-version automatic replay must do no installation work');
  }finally{process.argv.pop();}
  const agent=path.join(installDir,'agent.cjs'),before=fs.readFileSync(agent,'utf8')+'\n// old installed agent\n';
  fs.writeFileSync(agent,before);
  const receipt=path.join(installDir,'startup-helper/state.json');fs.writeFileSync(receipt,JSON.stringify({lastAttemptAt:123,event:'reopened'}));
  for(const job of ['com.codexusagebadge.agent','com.codexusagebadge.startup']){
    failJob=job;await assert.rejects(manager.install(),/已恢复安装前的程序文件/);
    assert.equal(jobs.size,3);assert.equal(fs.readFileSync(agent,'utf8'),before);
    assert.equal(JSON.parse(fs.readFileSync(receipt,'utf8')).lastAttemptAt,123);
  }
  fs.mkdirSync(path.join(launcher,'Contents'),{recursive:true});
  fs.writeFileSync(path.join(launcher,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.codexusagebadge.launcher</string></dict></plist>');
  fs.symlinkSync(launcher,shortcut);
  await manager.install();
  assert.equal(fs.existsSync(launcher),false);assert.throws(()=>fs.lstatSync(shortcut),{code:'ENOENT'});
  assert.ok(calls.some(c=>c[0].endsWith('/lsregister')));
  await manager.uninstall();assert.equal(jobs.size,0);assert.equal(fs.existsSync(installDir),false);
  assert.ok(messages.some(s=>s.includes('部分窗口暂不可连接')));
  fs.mkdirSync(path.join(launcher,'Contents'),{recursive:true});
  fs.writeFileSync(path.join(launcher,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>unrelated.app</string></dict></plist>');
  fs.writeFileSync(shortcut,'unrelated desktop file');
  await manager.install();await manager.uninstall();
  assert.equal(fs.readFileSync(shortcut,'utf8'),'unrelated desktop file');assert.ok(fs.existsSync(path.join(launcher,'Contents/Info.plist')));
  assert.ok(manager.startupConfig().ProgramArguments.at(-1).endsWith('startup-helper/watch.cjs'));
  assert.equal(manager.startupConfig().ProcessType,'Interactive','startup helper must not be throttled during client launch');
  console.log('PASS original-icon install, two-service rollback, cooldown preservation, legacy migration, offline uninstall and unrelated shortcut preservation');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
