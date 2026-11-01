// armTwoClickAction is defined in twoClickConfirm.js, loaded before this file.
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.js-delete-btn').forEach(btn => {
        armTwoClickAction(btn, {
            url: btn.dataset.deleteUrl,
            armedText: 'Confirm delete?',
            armedClass: 'btn-danger',
            restClass: 'btn-outline-danger',
            onFail: 'Failed to delete comic.'
        });
    });

    document.querySelectorAll('.js-clear-btn').forEach(btn => {
        armTwoClickAction(btn, {
            url: btn.dataset.clearUrl,
            armedText: `Confirm: ${btn.dataset.clearLabel}?`,
            armedClass: 'btn-warning',
            restClass: btn.classList.contains('btn-outline-danger') ? 'btn-outline-danger' : 'btn-outline-warning',
            onFail: 'Failed to clear downloaded pages.'
        });
    });
});
