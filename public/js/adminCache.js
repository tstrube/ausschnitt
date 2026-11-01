// armTwoClickAction is defined in twoClickConfirm.js, loaded before this file.
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('.js-clear-cache-now-btn');
    if (!btn) return;
    armTwoClickAction(btn, {
        url: btn.dataset.clearUrl,
        armedText: `Confirm: ${btn.dataset.clearLabel}?`,
        armedClass: 'btn-danger',
        restClass: 'btn-outline-danger',
        onFail: 'Failed to clear cache.'
    });
});
