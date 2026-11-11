(() => {
    function resolveTheme(pref) {
        if (pref === 'system') {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        return pref;
    }

    function applyTheme(pref) {
        document.documentElement.setAttribute('data-bs-theme', resolveTheme(pref));
    }

    document.addEventListener('DOMContentLoaded', () => {
        // Only present in the default navbar (layout.pug's own `block body`) -
        // the reader and Select Elements pages opt out of it entirely for
        // their own fixed dark layouts, so there's nothing to wire up there.
        const select = document.getElementById('themeSelect');
        if (!select) return;

        select.value = localStorage.getItem('theme') || 'system';

        select.addEventListener('change', () => {
            localStorage.setItem('theme', select.value);
            applyTheme(select.value);
        });

        // Live-update if the OS-level preference changes while "System
        // theme" is selected, without needing a reload.
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if ((localStorage.getItem('theme') || 'system') === 'system') {
                applyTheme('system');
            }
        });
    });
})();
