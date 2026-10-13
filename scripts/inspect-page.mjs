// Drives a headless Chrome through DevTools: loads a page, runs steps, reports console errors, saves screenshots.
//   node scripts/inspect-page.mjs <url> <outDir> [step ...]
// A step is  wait:<ms> | shot:<name> | click:<text> | key:<Key> | type:<text> | eval:<js>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [url, outDir, ...steps] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const PORT = 9341;
const chrome = spawn('google-chrome-stable', ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.PROFILE_DIR}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const problems = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') problems.push('EXCEPTION ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 300));
  if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) problems.push(d.params.type.toUpperCase() + ' ' + d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  if (d.method === 'Network.loadingFailed' && !d.params.canceled) problems.push('NETFAIL ' + d.params.errorText);
});
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
for (const step of steps) {
  const i = step.indexOf(':'); const kind = step.slice(0, i); const arg = step.slice(i + 1);
  if (kind === 'wait') await sleep(Number(arg));
  else if (kind === 'shot') { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outDir}/${arg}.png`, Buffer.from(s.data, 'base64')); }
  else if (kind === 'click') console.log(`click "${arg}":`, await evaluate(`(() => { const want = ${JSON.stringify(arg)}.toLowerCase(); const el = [...document.querySelectorAll('button, a, [role=button], label, input')].find((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(want)); if (!el) return 'NOT FOUND'; el.click(); return 'ok'; })()`));
  else if (kind === 'key') { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: arg, code: arg.length === 1 ? `Key${arg.toUpperCase()}` : arg, windowsVirtualKeyCode: arg === 'Enter' ? 13 : arg === 'Escape' ? 27 : arg.toUpperCase().charCodeAt(0), text: type === 'keyDown' && arg.length === 1 ? arg : undefined }); }
  else if (kind === 'hold') { const [k, ms] = arg.split(','); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }); await sleep(Number(ms)); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }); }
  else if (kind === 'type') await send('Input.insertText', { text: arg });
  else if (kind === 'eval') console.log('eval:', JSON.stringify(await evaluate(arg)));
}
console.log('page:', JSON.stringify(await evaluate(`({ canvases: document.querySelectorAll('canvas').length, canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(), webgl: !!document.createElement('canvas').getContext('webgl2'), buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 30)).filter(Boolean).slice(0, 24), text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500) })`)));
console.log(problems.length ? `problems (${problems.length}):\n  ` + [...new Set(problems)].slice(0, 12).join('\n  ') : 'no console errors');
ws.close(); chrome.kill();
