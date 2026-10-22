// 语言菜单不改变收发状态，不需要原版 Dialog.hide 重置标题和站点图标。
LanguageSelectDialog.prototype.hide = function () {
    this.currentLanguageBtn?.classList.remove('current');
    this.$el.removeAttribute('show');
    this.$languageSelectBtn.focus();
};

LanguageSelectDialog.prototype.selectLanguage = async function (event) {
    event.preventDefault();
    // currentTarget 始终是绑定监听器的按钮，点击内部文字也不会误选系统语言。
    const languageCode = event.currentTarget.value;
    if (languageCode) localStorage.setItem('language_code', languageCode);
    else localStorage.removeItem('language_code');
    await Localization.setTranslation(languageCode);
    this.hide();
};
