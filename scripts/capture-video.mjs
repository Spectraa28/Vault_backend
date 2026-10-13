// Renders web/explainer.html frame by frame through Chrome DevTools and pipes JPEGs to ffmpeg.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const [page, out] = process.argv.slice(2);
const FPS = 20, PORT = 9339;
const chrome = spawn('google-chrome-stable', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.PROFILE_DIR}`, 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: n, method, params })); });

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: `file://${page}` });
await sleep(1500);
await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
const { result } = await send('Runtime.evaluate', { expression: 'window.DURATION' });
const frames = Math.round((result.value / 1000) * FPS);

const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
for (let f = 0; f < frames; f++) {
  await send('Runtime.evaluate', { expression: `renderAt(${Math.round((f * 1000) / FPS)})` });
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  if (!ffmpeg.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((r) => ffmpeg.stdin.once('drain', r));
}
ffmpeg.stdin.end();
await new Promise((r) => ffmpeg.on('close', r));
ws.close(); chrome.kill();
console.log(`wrote ${frames} frames to ${out}`);
