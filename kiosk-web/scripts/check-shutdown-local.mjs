import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const python=process.env.SWITCH_QA_PYTHON;
if(!python)throw Error('Set SWITCH_QA_PYTHON to a Python executable with Pillow.');
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;await new Promise(r=>probe.close(r));
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'switch-shutdown-'));
const child=spawn(python,['backend/server.py','--file-mode','--no-browser','--port',String(port),'--data',folder]);
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
let browser;
try {
  await expect.poll(()=>output.includes(`SWitch local kiosk: http://127.0.0.1:${port}/`),{timeout:10000}).toBe(true);
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  const page=await browser.newPage({viewport:{width:800,height:1280}});
  const base=`http://127.0.0.1:${port}`;
  await page.goto(base+'/?kiosk=1');
  const corner=page.getByRole('button',{name:'키오스크 종료 메뉴',exact:true});
  for(let i=0;i<5;i++)await corner.click();
  const modal=page.getByRole('dialog',{name:'키오스크 종료'});
  await expect(modal.getByRole('heading')).toHaveText('종료하시겠습니까?');
  await page.screenshot({path:'qa/shutdown-dialog.png'});
  await modal.getByRole('button',{name:'아니요',exact:true}).click();
  const status=await page.request.get(base+'/api/status');expect(status.ok()).toBe(true);
  expect((await status.json()).stopping).toBe(false);
  for(let i=0;i<5;i++)await corner.click();
  await modal.getByRole('button',{name:'예',exact:true}).click();
  const result=await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Backend did not stop')),10000))]);
  expect(result).toEqual({code:0,signal:null});
  let listenerClosed=false;
  try { await fetch(base+'/api/status',{signal:AbortSignal.timeout(1000)}); } catch { listenerClosed=true; }
  expect(listenerClosed).toBe(true);
  const report={actualUIConfirmation:true,cancelKeepsRunning:true,backendExitCode:result.code,listenerClosed,
    settingsDatabasePreserved:!!(await fs.stat(path.join(folder,'jobs.sqlite3'))),windowsNativeExecutionTested:false};
  await fs.writeFile('qa/shutdown-local-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  if(browser)await browser.close();
  if(child.exitCode===null){child.kill('SIGINT');await exited;}
  await fs.rm(folder,{recursive:true,force:true});
}
