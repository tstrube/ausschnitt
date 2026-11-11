document.addEventListener('DOMContentLoaded', () => {
    const comicImage = document.getElementById('comicImage');
    const imageWrap = document.getElementById('imageWrap');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const resumeBanner = document.getElementById('resumeBanner');
    const resumeBtn = document.getElementById('resumeBtn');
    const setBookmarkBtn = document.getElementById('setBookmarkBtn');
    const historyBtn = document.getElementById('historyBtn');
    const historyPanel = document.getElementById('historyPanel');
    const historyList = document.getElementById('historyList');
    const bookmarksBtn = document.getElementById('bookmarksBtn');
    const bookmarksPanel = document.getElementById('bookmarksPanel');
    const bookmarksList = document.getElementById('bookmarksList');
    const saveBookmarkForm = document.getElementById('saveBookmarkForm');
    const bookmarkNameInput = document.getElementById('bookmarkNameInput');

    const directions = {
        firstBtn: 'first',
        backBtn: 'back',
        pageFirstBtn: 'page-first',
        nextBtn: 'next',
        latestBtn: 'latest'
    };

    // What's on screen and whether it's the live bookmark - Ignore/Undo
    // send these so they act on exactly this panel.
    let currentPanelId = initialPanelId;
    let currentAtBookmark = initialAtBookmark;

    function setAtBookmark(atBookmark) {
        currentAtBookmark = atBookmark;
        resumeBanner.classList.toggle('visible', !atBookmark);
    }

    function formatRelativeTime(isoString) {
        const diffMs = Date.now() - new Date(isoString).getTime();
        const minutes = Math.round(diffMs / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    }

    function renderHistory(entries) {
        historyList.innerHTML = '';
        if (!entries || !entries.length) {
            historyList.innerHTML = '<li class="text-muted">No checkpoints yet - use "Save Resume Point".</li>';
            return;
        }
        entries.forEach(entry => {
            const li = document.createElement('li');
            li.className = 'd-flex align-items-center justify-content-between gap-2 mb-1';
            const label = document.createElement('span');
            const tag = entry.source === 'auto' ? ' (auto-saved)' : '';
            label.textContent = formatRelativeTime(entry.created_at) + tag;
            const goBtn = document.createElement('button');
            goBtn.className = 'btn btn-sm btn-outline-light';
            goBtn.type = 'button';
            goBtn.textContent = 'Go';
            goBtn.addEventListener('click', () => restoreBookmark(entry.id));
            li.appendChild(label);
            li.appendChild(goBtn);
            historyList.appendChild(li);
        });
    }

    renderHistory(initialBookmarkHistory);

    function suggestedBookmarkName() {
        const pad = n => String(n).padStart(2, '0');
        const d = new Date();
        return `${comicTitle} — ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function renderBookmarks(entries) {
        bookmarksList.innerHTML = '';
        if (!entries || !entries.length) {
            bookmarksList.innerHTML = '<li class="text-muted">No bookmarks for this comic yet.</li>';
            return;
        }
        entries.forEach(entry => {
            const li = document.createElement('li');
            li.className = 'd-flex align-items-center justify-content-between gap-2 mb-1';

            const label = document.createElement('span');
            label.className = 'text-truncate';
            label.style.maxWidth = '8rem';
            label.textContent = entry.name;

            const goBtn = document.createElement('button');
            goBtn.className = 'btn btn-sm btn-outline-light';
            goBtn.type = 'button';
            goBtn.textContent = 'Go';
            goBtn.addEventListener('click', () => performNav(`/reader/${comicId}/bookmarks/${entry.id}/go`));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-sm btn-outline-danger';
            deleteBtn.type = 'button';
            deleteBtn.textContent = '×';
            deleteBtn.setAttribute('aria-label', 'Delete bookmark');
            deleteBtn.addEventListener('click', async () => {
                try {
                    const res = await fetch(`/bookmarks/${entry.id}/delete`, { method: 'POST' });
                    if (!res.ok) throw new Error('Request failed');
                    li.remove();
                } catch {
                    showToast('Failed to delete bookmark.', { type: 'error' });
                }
            });

            li.appendChild(label);
            li.appendChild(goBtn);
            li.appendChild(deleteBtn);
            bookmarksList.appendChild(li);
        });
    }

    renderBookmarks(initialBookmarks);
    bookmarkNameInput.value = suggestedBookmarkName();

    historyBtn.addEventListener('click', () => {
        bookmarksPanel.classList.remove('visible');
        historyPanel.classList.toggle('visible');
    });

    bookmarksBtn.addEventListener('click', () => {
        historyPanel.classList.remove('visible');
        bookmarksPanel.classList.toggle('visible');
    });

    saveBookmarkForm.addEventListener('submit', async e => {
        e.preventDefault();
        const name = bookmarkNameInput.value.trim();
        if (!name) return;

        try {
            const res = await fetch(`/reader/${comicId}/bookmarks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                showToast((data && data.error) || 'Failed to save bookmark.', { type: 'error' });
                return;
            }
            renderBookmarks(data.bookmarks);
            bookmarkNameInput.value = suggestedBookmarkName();
            showToast('Bookmark saved.');
        } catch {
            showToast('Failed to save bookmark - check your connection.', { type: 'error' });
        }
    });

    let navigating = false;

    function setLoading(isLoading) {
        loadingIndicator.classList.toggle('visible', isLoading);
    }

    // Returns the response data on success, null otherwise.
    async function performNav(url, body = {}) {
        if (navigating) return null;
        navigating = true;
        setLoading(true);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => null);

            if (!res.ok) {
                showToast((data && data.error) || `Navigation failed (${res.status}).`, { type: 'error' });
                return null;
            }

            if (data && data.imageUrl) {
                comicImage.src = data.imageUrl;
                currentPanelId = data.panel.id;
                setAtBookmark(!!data.atBookmark);
                renderHistory(data.bookmarkHistory);
                renderBookmarks(data.bookmarks);
                return data;
            }
            showToast('No image available.', { type: 'error' });
            return null;
        } catch (err) {
            console.error('Navigation error:', err);
            showToast('Navigation failed - check your connection.', { type: 'error' });
            return null;
        } finally {
            setLoading(false);
            navigating = false;
        }
    }

    // Always say which panel this page is showing - the server's own idea
    // of it is shared with any other device reading this comic.
    function navigate(direction) {
        return performNav(`/reader/${comicId}/nav/${direction}`, { panelId: currentPanelId });
    }

    function restoreBookmark(historyId) {
        return performNav(`/reader/${comicId}/bookmarks/${historyId}/restore`);
    }

    Object.entries(directions).forEach(([btnId, direction]) => {
        const button = document.getElementById(btnId);
        if (!button) return;
        button.addEventListener('click', () => navigate(direction));
    });

    resumeBtn.addEventListener('click', () => navigate('resume'));
    setBookmarkBtn.addEventListener('click', () => navigate('bookmark'));

    // "Ignore" needs the two-click confirm UI but not armTwoClickAction's
    // built-in fetch-and-redirect - it goes through navigate('ignore') like
    // any other nav action, so the image updates in place instead of a
    // full page reload.
    const ignoreBtn = document.getElementById('ignoreBtn');
    const IGNORE_ICON = '🚫';
    let ignoreArmed = false;
    let ignoreResetTimer = null;
    ignoreBtn.addEventListener('click', () => {
        if (!ignoreArmed) {
            ignoreArmed = true;
            ignoreBtn.textContent = 'OK?';
            ignoreBtn.classList.replace('btn-outline-light', 'btn-warning');
            ignoreResetTimer = setTimeout(() => {
                ignoreArmed = false;
                ignoreBtn.textContent = IGNORE_ICON;
                ignoreBtn.classList.replace('btn-warning', 'btn-outline-light');
            }, 3000);
            return;
        }
        clearTimeout(ignoreResetTimer);
        ignoreArmed = false;
        ignoreBtn.textContent = IGNORE_ICON;
        ignoreBtn.classList.replace('btn-warning', 'btn-outline-light');
        ignorePage();
    });

    async function ignorePage() {
        const data = await performNav(`/reader/${comicId}/nav/ignore`, {
            panelId: currentPanelId,
            fromPanelId: currentAtBookmark ? currentPanelId : null
        });
        if (!data || !data.ignoredPanelId) return;
        const ignoredPanelId = data.ignoredPanelId;
        showToast('Page ignored.', {
            duration: 8000,
            action: {
                label: 'Undo',
                onClick: () => undoIgnore(ignoredPanelId)
            }
        });
    }

    // Un-ignores, then reloads - the server has already moved this reader
    // back to that panel, so a fresh load shows it.
    async function undoIgnore(panelId) {
        setLoading(true);
        try {
            const res = await fetch(`/reader/${comicId}/unignore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ panelId, fromPanelId: currentAtBookmark ? currentPanelId : null })
            });
            if (res.ok) {
                window.location.reload();
                return;
            }
            const data = await res.json().catch(() => null);
            showToast((data && data.error) || 'Undo failed.', { type: 'error' });
        } catch {
            showToast('Undo failed - check your connection.', { type: 'error' });
        }
        setLoading(false);
    }

    // Swipe left/right over the image to go next/back - the primary
    // interaction on a phone, buttons are the fallback.
    const SWIPE_THRESHOLD_PX = 50;
    let touchStartX = null;
    let touchStartY = null;

    imageWrap.addEventListener('touchstart', e => {
        const t = e.changedTouches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
    }, { passive: true });

    function isPinchZoomed() {
        return !!window.visualViewport && window.visualViewport.scale > 1.05;
    }

    imageWrap.addEventListener('touchend', e => {
        if (touchStartX === null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartX;
        const dy = t.clientY - touchStartY;
        touchStartX = null;

        // While pinch-zoomed, a one-finger drag is panning around the
        // zoomed image, not a page-turn swipe.
        if (isPinchZoomed()) return;

        if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
            navigate(dx < 0 ? 'next' : 'back');
        }
    }, { passive: true });
});
