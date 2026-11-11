// Two-click action instead of a native confirm() popup: first click arms
// the button, a second click within a few seconds actually performs it.
// Shared by the comic list, bookmarks manager, admin cache controls and the
// readers' Ignore button.
function armTwoClickAction(btn, { url, armedText, armedClass, restClass, onFail, onSuccess }) {
    const originalText = btn.textContent;
    let armed = false;
    let resetTimer = null;

    function disarm() {
        armed = false;
        clearTimeout(resetTimer);
        btn.textContent = originalText;
        btn.classList.remove(armedClass);
        btn.classList.add(restClass);
    }

    btn.addEventListener('click', () => {
        if (!armed) {
            armed = true;
            btn.textContent = armedText;
            btn.classList.remove(restClass);
            btn.classList.add(armedClass);
            resetTimer = setTimeout(disarm, 3000);
            return;
        }

        disarm();
        fetch(url, { method: 'POST' })
            .then(res => {
                if (!res.ok) throw new Error(`Request failed: ${res.status}`);
                if (onSuccess) return onSuccess(res);
                window.location.href = res.url;
            })
            .catch(() => showToast(onFail, { type: 'error' }));
    });
}
