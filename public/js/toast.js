// Lightweight, non-blocking notification - replaces alert()/confirm() so a
// message never stops the user from continuing to interact with the page.
(() => {
    function ensureContainer() {
        let el = document.getElementById('toast-container');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toast-container';
            document.body.appendChild(el);
        }
        return el;
    }

    // `action` ({ label, onClick }) adds a button to the toast, e.g. Undo -
    // clicking it dismisses the toast right away.
    window.showToast = function showToast(message, { type = 'info', duration = 4000, action = null } = {}) {
        const container = ensureContainer();
        const toast = document.createElement('div');
        toast.className = `toast-message${type === 'error' ? ' toast-error' : ''}`;
        toast.textContent = message;
        container.appendChild(toast);

        let dismissed = false;
        function dismiss() {
            if (dismissed) return;
            dismissed = true;
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 250);
        }

        if (action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-light toast-action';
            btn.textContent = action.label;
            btn.addEventListener('click', () => {
                dismiss();
                action.onClick();
            });
            toast.appendChild(btn);
        }

        requestAnimationFrame(() => toast.classList.add('visible'));

        setTimeout(dismiss, duration);
    };
})();
