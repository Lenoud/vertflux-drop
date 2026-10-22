import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const ui = await readFile(new URL('../public/scripts/ui-main.js', import.meta.url), 'utf8');
const themeAdapter = await readFile(new URL('../cloudflare/theme-controls.js', import.meta.url), 'utf8');
const room = await readFile(new URL('../public/scripts/vertflux-room.js', import.meta.url), 'utf8');
const themeClass = ui.slice(ui.indexOf('class ThemeUI {'), ui.indexOf('class HeaderUI {'));
const deferredUi = await readFile(new URL('../public/scripts/ui.js', import.meta.url), 'utf8');
const languageAdapter = await readFile(new URL('../cloudflare/language-controls.js', import.meta.url), 'utf8');
const languageClasses = deferredUi.slice(deferredUi.indexOf('class Dialog {'), deferredUi.indexOf('class ReceiveDialog extends Dialog {'));

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle: (name, enabled) => enabled ? values.add(name) : values.delete(name),
  };
}

function themes(localStorage = storage(), systemDark = false) {
  const body = { classList: classList() }, buttons = {};
  for (const mode of ['auto', 'light', 'dark']) {
    const button = new EventTarget();
    button.classList = classList(mode === 'auto' ? ['selected'] : []);
    button.attributes = {};
    button.setAttribute = (name, value) => { button.attributes[name] = value; };
    buttons[`theme-${mode}`] = button;
  }
  const context = vm.createContext({ localStorage,
    document: { body, getElementById: id => buttons[id] },
    window: { matchMedia: query => ({ matches: query.includes('dark') ? systemDark : !systemDark }) },
  });
  vm.runInContext(themeClass + '\n' + themeAdapter + '\nthis.theme = new ThemeUI();', context);
  const click = mode => buttons[`theme-${mode}`].dispatchEvent(new Event('click'));
  return { body, buttons, click, localStorage };
}

function assertTheme(f, mode) {
  assert.equal(f.body.classList.contains('dark-theme'), mode === 'dark');
  assert.equal(f.body.classList.contains('light-theme'), mode === 'light');
  assert.equal(f.localStorage.getItem('theme'), mode === 'auto' ? null : mode);
  for (const name of ['auto', 'light', 'dark']) {
    const button = f.buttons[`theme-${name}`];
    assert.equal(button.classList.contains('selected'), name === mode);
    assert.equal(button.attributes['aria-pressed'], String(name === mode));
  }
}

test('重复选择浅色或深色保持该模式，切换时只有一个选项被选中', () => {
  const f = themes();
  for (const mode of ['dark', 'dark', 'light', 'light', 'dark']) {
    f.click(mode);
    assertTheme(f, mode);
  }
});

test('跟随系统会清除手动主题，重复点击不固定成当前系统颜色', () => {
  for (const systemDark of [false, true]) {
    const f = themes(storage(), systemDark);
    f.click(systemDark ? 'light' : 'dark');
    f.click('auto');
    assertTheme(f, 'auto');
    f.click('auto');
    assertTheme(f, 'auto');
  }
});

test('刷新后恢复手动主题，选中状态和辅助技术状态保持一致', () => {
  for (const mode of ['light', 'dark']) {
    const saved = storage({ theme: mode });
    assertTheme(themes(saved), mode);
    assertTheme(themes(saved, true), mode);
  }
});

function loadRoom(localStorage) {
  const context = vm.createContext({ localStorage, sessionStorage: storage(), crypto,
    location: { pathname: '/join/00000000-0000-4000-8000-000000000000', hash: '' },
    history: { replaceState() {} }, window: {},
    // 只执行页面启动，布局在浏览器中验证。
    document: { addEventListener() {} },
  });
  vm.runInContext(room, context);
}

test('首次进入默认中文，已有语言选择不会被重置', () => {
  const fresh = storage();
  loadRoom(fresh);
  assert.equal(fresh.getItem('language_code'), 'zh-CN');
  const saved = storage({ language_code: 'ja' });
  loadRoom(saved);
  assert.equal(saved.getItem('language_code'), 'ja');
});

test('用户选择系统语言后刷新仍跟随系统，不再被强制改回中文', () => {
  const saved = storage();
  loadRoom(saved);
  saved.removeItem('language_code');
  loadRoom(saved);
  assert.equal(saved.getItem('language_code'), null);
  saved.setItem('language_code', 'en');
  loadRoom(saved);
  assert.equal(saved.getItem('language_code'), 'en');
});

test('点击语言按钮内的文字也能选中该语言，关闭后保留房间标题和图标并返回焦点', async () => {
  let focused = false, translated, favicon = 'vertflux.svg';
  const localStorage = storage(), selected = { classList: classList(['current']) };
  const button = { addEventListener() {}, focus() { focused = true; } };
  const dialog = {
    attributes: {}, querySelector: () => null,
    querySelectorAll: selector => selector === '[close]' ? [] : [button],
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
  const document = { title: '我的文件快传 · Vertflux Drop' };
  const context = vm.createContext({ document, localStorage,
    $: id => id === 'language-selector' ? button : dialog,
    Events: { on() {} },
    Localization: { async setTranslation(code) { translated = code; } },
    changeFavicon: value => { favicon = value; },
  });
  vm.runInContext(languageClasses + '\n' + languageAdapter + '\nthis.language = new LanguageSelectDialog();', context);
  const language = context.language;
  language.currentLanguageBtn = selected;
  dialog.setAttribute('show', true);
  // 模拟点击按钮内的 span，而不是按钮自身。
  await language.selectLanguage({ preventDefault() {}, currentTarget: { value: 'en' }, target: {} });
  assert.equal(translated, 'en');
  assert.equal(localStorage.getItem('language_code'), 'en');
  assert.equal(dialog.attributes.show, undefined);
  assert.equal(selected.classList.contains('current'), false);
  assert.equal(focused, true);
  assert.equal(document.title, '我的文件快传 · Vertflux Drop');
  assert.equal(favicon, 'vertflux.svg');
  await language.selectLanguage({ preventDefault() {}, currentTarget: { value: '' }, target: {} });
  assert.equal(localStorage.getItem('language_code'), null);
});
