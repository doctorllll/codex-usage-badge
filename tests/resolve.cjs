const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {resolveCodexBin,formatRateLimits}=require('../agent.cjs');
const {agentConfig}=require('../manage.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'badge-cli-resolution-'));
try {
  const resources=path.join(root,'Contents/Resources');
  const modern=path.join(resources,'codex-cli/bin/codex');
  const nested=path.join(resources,'codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const legacy=path.join(resources,'codex');
  function executable(file){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'#!/bin/sh\nexit 0\n',{mode:0o755});}
  assert.throws(()=>resolveCodexBin(undefined,root),/找不到客户端内置/);
  executable(legacy);
  assert.equal(resolveCodexBin(undefined,root),legacy);
  fs.unlinkSync(legacy);executable(nested);
  assert.equal(resolveCodexBin(legacy,root),nested,'stale explicit paths must discover the new package layout');
  executable(modern);
  assert.equal(resolveCodexBin(undefined,root),modern);
  fs.chmodSync(modern,0o600);
  assert.equal(resolveCodexBin(undefined,root),nested,'a non-executable entrypoint must not be selected');
  fs.unlinkSync(modern);fs.mkdirSync(modern);
  assert.equal(resolveCodexBin(undefined,root),nested,'an executable directory is not a CLI');
  const custom=path.join(root,'explicit-codex');executable(custom);
  assert.equal(resolveCodexBin(custom,root),custom);
  assert.equal(agentConfig().ProgramArguments[0],process.execPath);
  assert.equal(agentConfig().ProcessType,'Interactive','agent must not be throttled during client launch');
  const usage=formatRateLimits({rateLimits:{limitId:'codex',planType:'prolite',primary:{usedPercent:7,windowDurationMins:10080},secondary:null}});
  assert.equal(usage.percent,93);
  assert.equal(usage.windowLabel,'周');
  console.log('PASS modern/legacy CLI discovery, stale paths, permissions, installer preflight and primary weekly Pro Lite quota');
} finally {fs.rmSync(root,{recursive:true,force:true});}
