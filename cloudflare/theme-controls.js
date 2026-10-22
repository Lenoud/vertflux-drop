// 明确选择一种外观；重复点击当前选项不再切换到另一种主题。
function setDropTheme(mode) {
    document.body.classList.remove('light-theme', 'dark-theme');
    if (mode === 'auto') {
        // 让原版 CSS 的媒体查询持续跟随系统，而不是固定成点击时的系统颜色。
        localStorage.removeItem('theme');
    } else {
        document.body.classList.add(`${mode}-theme`);
        localStorage.setItem('theme', mode);
    }
    for (const name of ['auto', 'light', 'dark']) {
        const button = this[`$theme${name[0].toUpperCase() + name.slice(1)}Btn`];
        button.classList.toggle('selected', name === mode);
        button.setAttribute('aria-pressed', String(name === mode));
    }
}
ThemeUI.prototype.setModeToAuto = function () { setDropTheme.call(this, 'auto'); };
ThemeUI.prototype.setModeToLight = function () { setDropTheme.call(this, 'light'); };
ThemeUI.prototype.setModeToDark = function () { setDropTheme.call(this, 'dark'); };
ThemeUI.prototype.onClickAuto = function () { this.setModeToAuto(); };
ThemeUI.prototype.onClickLight = function () { this.setModeToLight(); };
ThemeUI.prototype.onClickDark = function () { this.setModeToDark(); };
