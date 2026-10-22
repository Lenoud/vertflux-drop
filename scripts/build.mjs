import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await cp('public', 'dist', { recursive: true, filter: path => !path.endsWith('.sketch') });
let html = await readFile('public/index.html', 'utf8');
html = html.replace('<html lang="en">', '<html lang="zh-CN">').replace('<head>', '<head><base href="/">');
html = html.replace(/<title>.*?<\/title>/, '<title>Vertflux Drop · 文件快传</title>');
html = html.replace('</head>', '<link rel="stylesheet" href="/styles/vertflux.css"><link rel="stylesheet" href="/styles/vertflux-room.css"><script src="/scripts/vertflux-room.js" defer></script></head>');
html = html.replaceAll('https://pairdrop.net/', 'https://drop.vertflux.com/');
html = html.replace('href="images/favicon-96x96.png"', 'href="/images/vertflux.svg"');
await writeFile('dist/index.html', html);
const network = await readFile('public/scripts/network.js', 'utf8');
const adapter = await readFile('cloudflare/server-connection.js', 'utf8');
const lifecycle = await readFile('cloudflare/peer-lifecycle.js', 'utf8');
await writeFile('dist/scripts/network.js', adapter + '\n' + network.slice(network.indexOf('class Peer {')) + '\n' + lifecycle);
const themes = await readFile('cloudflare/theme-controls.js', 'utf8');
await writeFile('dist/scripts/ui-main.js', await readFile('public/scripts/ui-main.js', 'utf8') + '\n' + themes);
const languages = await readFile('cloudflare/language-controls.js', 'utf8');
await writeFile('dist/scripts/ui.js', await readFile('public/scripts/ui.js', 'utf8') + '\n' + languages);
// 上游当前已禁用 HEIC 转换，移除仍被预加载的 1.3 MB 库，不影响原文件传输。
const main = await readFile('dist/scripts/main.js', 'utf8');
await writeFile('dist/scripts/main.js', main.replace(/\s*"scripts\/libs\/heic2any\.min\.js",/, ''));
for (const locale of ['zh-CN', 'en']) {
  const strings = JSON.parse(await readFile(`public/lang/${locale}.json`, 'utf8'));
  strings.instructions['no-peers-title'] = locale === 'zh-CN' ? '等待另一台设备加入' : 'Waiting for another device';
  strings.instructions['no-peers-subtitle'] = locale === 'zh-CN' ? '将邀请链接发给对方。连接后，点击设备即可发送文件。' : 'Share the invitation. Select the connected device to send files.';
  await writeFile(`dist/lang/${locale}.json`, JSON.stringify(strings));
}
// 构建时移除上游浏览器调试输出，防止 SDP、文字内容和传输元数据出现在控制台。
for (const name of ['network', 'main', 'ui', 'ui-main', 'vertflux-room']) {
  const path = `dist/scripts/${name}.js`;
  const js = await readFile(path, 'utf8');
  await writeFile(path, (await transform(js, { drop: ['console', 'debugger'], target: 'es2022' })).code);
}
const assetUrl = async asset => `${asset}?v=${createHash('sha256').update(await readFile(`dist/${asset}`)).digest('hex').slice(0, 12)}`;
// 延迟加载的收发脚本也需要版本号，先更新引用，再计算入口脚本的内容版本。
let mainJs = await readFile('dist/scripts/main.js', 'utf8');
for (const asset of ['scripts/ui.js', 'scripts/network.js']) mainJs = mainJs.replaceAll(`"${asset}"`, `"${await assetUrl(asset)}"`);
await writeFile('dist/scripts/main.js', mainJs);
// HTML 不缓存，每次发布用内容版本号引用变更资源，避免普通刷新仍命中旧样式和脚本。
for (const page of ['index', 'vertflux']) {
  const path = `dist/${page}.html`;
  let pageHtml = await readFile(path, 'utf8');
  for (const asset of ['scripts/main.js', 'scripts/ui-main.js', 'scripts/vertflux-room.js', 'styles/vertflux.css', 'styles/vertflux-room.css']) {
    const versioned = await assetUrl(asset);
    pageHtml = pageHtml.replaceAll(`"${asset}"`, `"${versioned}"`).replaceAll(`"/${asset}"`, `"/${versioned}"`);
  }
  await writeFile(path, pageHtml);
}
await writeFile('dist/service-worker.js', "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));\n");
await writeFile('dist/manifest.json', JSON.stringify({ name: 'Vertflux Drop · 文件快传', short_name: 'Vertflux Drop', start_url: '/', display: 'standalone', background_color: '#f5f4ef', theme_color: '#234333', icons: [{ src: '/images/vertflux.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }));
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
await writeFile('dist/_routes.json', JSON.stringify({ version: 1, include: ['/*'], exclude: [] }));
await build({ entryPoints: ['edge/index.mjs'], outfile: 'dist/_worker.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
console.log('Vertflux Drop 前端与 Pages 网关构建完成。');
