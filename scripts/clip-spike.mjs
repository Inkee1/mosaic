import { app, BrowserWindow, View, WebContentsView, desktopCapturer } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
app.whenReady().then(async () => {
const window = new BrowserWindow({ width: 650, height: 450, frame: false, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
await window.loadURL('data:text/html,<body style="margin:0;background:white"><header style="height:65px;background:navy;color:white">CLIPPING TEST</header>');
const container = new View();
container.setBounds({ x: 100, y: 100, width: 200, height: 160 });
container.setBackgroundColor('#888888');
container.setBorderRadius(1);
const child = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
container.addChildView(child);
window.contentView.addChildView(container);
child.setBounds({ x: -70, y: -50, width: 400, height: 300 });
await child.webContents.loadURL('data:text/html,<body style="margin:0;background:rgb(255,0,0);height:100vh"><h1>Native content</h1>');
await new Promise(resolve => setTimeout(resolve, 300));
// capturePage captures only BrowserWindow.webContents, excluding native child
// views. Capture this window's composed surface to actually verify clipping.
const source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 650, height: 450 } }))
  .find(source => source.id === window.getMediaSourceId());
assert.ok(source, 'The native test window must be available for capture');
const picture = source.thumbnail;
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/clip-spike.png', picture.toPNG());
const bitmap = picture.toBitmap(); const width = picture.getSize().width;
const pixel = (x,y) => Array.from(bitmap.subarray((y*width+x)*4,(y*width+x)*4+4));
try {
  const viewport=await child.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
  console.log(JSON.stringify({ screenshot: picture.getSize(), outside: pixel(65,85), inside:pixel(200,200), viewport }));
  assert.deepEqual(pixel(65,85).slice(0,3),[255,255,255],'WebContents must not draw outside its clipping container');
  assert.deepEqual(pixel(200,200).slice(0,3),[0,0,255],'Visible native content must remain red');
  assert.deepEqual(viewport,{width:400,height:300},'Clipping must preserve the full page viewport');
} catch(error) {console.error(error);process.exitCode=1;}
finally {child.webContents.close(); window.close(); app.exit(process.exitCode||0);}
}).catch(error => { console.error(error); app.exit(1); });
