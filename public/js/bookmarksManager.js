// armTwoClickAction is defined in twoClickConfirm.js, loaded before this file.
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.js-delete-bookmark-btn').forEach(btn => {
        armTwoClickAction(btn, {
            url: btn.dataset.deleteUrl,
            armedText: 'Confirm delete?',
            armedClass: 'btn-danger',
            restClass: 'btn-outline-danger',
            onFail: 'Failed to delete bookmark.'
        });
    });
});
