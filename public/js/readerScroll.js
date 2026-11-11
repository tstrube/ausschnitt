document.addEventListener('DOMContentLoaded', () => {
    const feed = document.getElementById('scrollFeed');
    const topSentinel = document.getElementById('topSentinel');
    const topSpacer = document.getElementById('topSpacer');
    const bottomSentinel = document.getElementById('bottomSentinel');
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
    const ignoreBtn = document.getElementById('ignoreBtn');
    const firstBtn = document.getElementById('firstBtn');
    const latestBtn = document.getElementById('latestBtn');

    const LOAD_MORE_COUNT = 10;

    let mostVisiblePanelId = anchorPanelId;
    let loadingMore = false;
    let noMoreBefore = false;
    // Unlike noMoreBefore (the start of an archive doesn't change), the
    // latest edge genuinely does move forward as a comic publishes new
    // pages - a plain sticky flag would mean a session that reached "no
    // more" once could never discover new content without a full reload.
    // null = not currently stalled; a timestamp = stalled since then, and
    // eligible for a fresh check once RECHECK_COOLDOWN_MS has passed.
    let noMoreAfterSince = null;
    const RECHECK_COOLDOWN_MS = 3 * 60 * 1000;
    // How far beyond the screen the feed keeps panels loaded, both ways.
    const LOAD_AHEAD_PX = 3000;

    function setAtBookmark(atBookmark) {
        resumeBanner.classList.toggle('visible', !atBookmark);
    }

    function setLoading(isLoading) {
        loadingIndicator.classList.toggle('visible', isLoading);
    }

    // Puts an element at the top of the feed.
    function scrollElementToTop(el) {
        feed.scrollTop += el.getBoundingClientRect().top - feed.getBoundingClientRect().top;
    }

    // --- bookmark history panel (same behavior as the paged reader) ---
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
            goBtn.addEventListener('click', () => jumpTo(`/reader/${comicId}/bookmarks/${entry.id}/restore`));
            li.appendChild(label);
            li.appendChild(goBtn);
            historyList.appendChild(li);
        });
    }

    renderHistory(initialBookmarkHistory);
    historyBtn.addEventListener('click', () => {
        bookmarksPanel.classList.remove('visible');
        historyPanel.classList.toggle('visible');
    });

    // --- named bookmarks panel (same behavior as the paged reader) ---
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
            goBtn.addEventListener('click', () => jumpTo(`/reader/${comicId}/bookmarks/${entry.id}/go`));

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

    // --- position tracking: report whichever panel is most visible, same
    // bookmark semantics as paged mode's Next/Back. ---
    //
    // The client tracks which panel it believes is the live bookmark
    // (`bookmarkPanelId`, null once it's jumped away) and sends it along as
    // `fromPanelId`; the server only moves the bookmark if that still
    // matches (a compare-and-set - see scroll-position in routes/reader.ts
    // for why the server's own cursor can't be trusted for this). Reports
    // go out strictly one at a time - a newer position seen while one is in
    // flight just waits for it - so they can't arrive out of order, and
    // every response is applied rather than some being discarded.
    const REPORT_DEBOUNCE_MS = 800;
    // Continuous scrolling keeps resetting the debounce - the cap makes sure
    // a position is saved at least this often while scrolling.
    const REPORT_MAX_WAIT_MS = 2500;

    let bookmarkPanelId = initialAtBookmark ? anchorPanelId : null;
    let lastReportedPanelId = anchorPanelId;
    let reportInFlight = null; // panel id currently being reported
    let reportDebounceTimer = null;
    let reportPendingSince = null;
    // Bumped by every jump - a report response that started before a jump
    // describes a feed that no longer exists and must not touch the banner.
    let navGeneration = 0;
    let jumping = false;

    function scheduleReport() {
        clearTimeout(reportDebounceTimer);
        if (reportPendingSince === null) reportPendingSince = Date.now();
        const wait = Math.max(0, Math.min(REPORT_DEBOUNCE_MS, reportPendingSince + REPORT_MAX_WAIT_MS - Date.now()));
        reportDebounceTimer = setTimeout(flushReport, wait);
    }

    function cancelPendingReport() {
        clearTimeout(reportDebounceTimer);
        reportDebounceTimer = null;
        reportPendingSince = null;
    }

    function flushReport() {
        cancelPendingReport();
        if (reportInFlight !== null || jumping) return; // re-checked once it lands
        const panelId = mostVisiblePanelId;
        if (panelId === lastReportedPanelId) return;

        const generation = navGeneration;
        reportInFlight = panelId;
        fetch(`/reader/${comicId}/scroll-position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ panelId, fromPanelId: bookmarkPanelId })
        }).then(res => res.ok ? res.json() : null)
            .then(data => {
                if (generation !== navGeneration || !data) return;
                lastReportedPanelId = panelId;
                bookmarkPanelId = data.atBookmark ? panelId : null;
                setAtBookmark(data.atBookmark);
            })
            .catch(() => {})
            .finally(() => {
                reportInFlight = null;
                if (generation === navGeneration && mostVisiblePanelId !== lastReportedPanelId) scheduleReport();
            });
    }

    // Leaving the page (home button, app switch, screen lock, closing the
    // tab) mustn't drop a position still waiting on the debounce. A beacon
    // survives the page going away, unlike a fetch.
    //
    // On a reload, though, the browser requests the new page *before* the
    // old one fires pagehide - so the new page gets built from the
    // previous report, the beacon then moves the bookmark forward, and the
    // new page disagrees with the server: the resume banner shows, a page
    // or two behind where you were. So the position is also noted in this
    // tab's sessionStorage (which survives a reload), and the new page
    // applies it on load - see restorePendingPosition below.
    const PENDING_KEY = `ausschnitt:pendingPosition:${comicId}`;
    const PENDING_MAX_AGE_MS = 15000;

    function flushOnHide() {
        if (jumping) return;
        cancelPendingReport();
        const panelId = mostVisiblePanelId;
        // Nothing new - but keep any note from moments ago: a reload fires
        // visibilitychange and then pagehide, and the second call must not
        // erase what the first just wrote.
        if (panelId === lastReportedPanelId && reportInFlight === null) return;
        if (panelId !== reportInFlight && panelId !== lastReportedPanelId) {
            // If a report is still in flight while following, the bookmark
            // is about to be that panel - chain from it.
            const fromPanelId = reportInFlight !== null && bookmarkPanelId !== null ? reportInFlight : bookmarkPanelId;
            const body = new Blob([JSON.stringify({ panelId, fromPanelId })], { type: 'application/json' });
            navigator.sendBeacon(`/reader/${comicId}/scroll-position`, body);
        }
        // Either the beacon or the in-flight report may still land after a
        // reload's new page request - note the position for that page.
        try {
            sessionStorage.setItem(PENDING_KEY, JSON.stringify({ panelId, fromPanelId: bookmarkPanelId, at: Date.now() }));
        } catch {}
        lastReportedPanelId = panelId;
        if (bookmarkPanelId !== null) bookmarkPanelId = panelId;
    }
    // The note is only for a page that's actually gone - once this one is
    // visible again, its own state is the truth and a leftover note could
    // only pull a later reload backwards.
    function clearPendingPosition() {
        try { sessionStorage.removeItem(PENDING_KEY); } catch {}
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide();
        else clearPendingPosition();
    });
    window.addEventListener('pageshow', e => { if (e.persisted) clearPendingPosition(); });
    window.addEventListener('pagehide', flushOnHide);

    // "Most visible" by on-screen height, not intersectionRatio - a ratio
    // makes a short panel peeking in fully at the very bottom edge beat a
    // tall panel filling the rest of the screen.
    const visibleHeights = new Map();
    const panelObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const id = Number(entry.target.dataset.panelId);
            visibleHeights.set(id, entry.isIntersecting ? entry.intersectionRect.height : 0);
        });
        let bestId = null;
        let bestHeight = 0;
        visibleHeights.forEach((height, id) => {
            if (height > bestHeight) {
                bestHeight = height;
                bestId = id;
            }
        });
        if (bestId !== null && bestId !== mostVisiblePanelId) {
            mostVisiblePanelId = bestId;
            scheduleReport();
        }
    }, { root: feed, threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] });

    // Panels are never removed from the feed while scrolling. Panels far
    // from the screen swap their image for a blank one instead: the box
    // keeps its exact size, so nothing above the screen ever changes height,
    // and the browser can drop the decoded image. Coming back within range
    // swaps it back in (from the browser cache - panel images are served
    // immutable).
    const BLANK_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const unloadObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const img = entry.target;
            if (entry.isIntersecting) {
                if (img.dataset.src && img.src !== img.dataset.src) img.src = img.dataset.src;
            } else if (img.style.aspectRatio) {
                // Only panels whose size is pinned (see sizePanel) - without
                // it, a blank image would collapse the box.
                img.src = BLANK_SRC;
            }
        });
    }, { root: feed, rootMargin: '5000px 0px' });

    // Pins the box to the panel's real proportions regardless of what image
    // it currently shows (the real one, or BLANK_SRC while unloaded). The
    // width/height attributes alone aren't enough: they only apply until an
    // image loads, and the 1x1 blank would then make the box square.
    function sizePanel(img) {
        const width = Number(img.getAttribute('width'));
        const height = Number(img.getAttribute('height'));
        if (!width || !height) return;
        img.style.width = `${width}px`;
        img.style.aspectRatio = `${width} / ${height}`;
    }

    function observePanel(img) {
        if (!img) return;
        img.dataset.src = img.getAttribute('src');
        sizePanel(img);
        panelObserver.observe(img);
        unloadObserver.observe(img);
    }

    function makeImg(p) {
        const img = document.createElement('img');
        img.className = 'reader-scroll-panel';
        img.src = p.imageUrl;
        // Final size known up front - see panelSize in routes/reader.ts.
        if (p.width && p.height) {
            img.width = p.width;
            img.height = p.height;
        }
        img.dataset.panelId = p.id;
        img.dataset.pageId = p.pageId;
        img.alt = 'Comic panel';
        img.decoding = 'async';
        return img;
    }

    document.querySelectorAll('.reader-scroll-panel').forEach(observePanel);

    function edgePanelId(edge) {
        const imgs = feed.querySelectorAll('.reader-scroll-panel');
        if (!imgs.length) return null;
        return Number((edge === 'top' ? imgs[0] : imgs[imgs.length - 1]).dataset.panelId);
    }

    // Everything above the panels lives in one spacer: a blank runway, kept
    // tall while there may be earlier panels to load. Earlier panels are
    // inserted into the bottom of that runway, taking their height from it,
    // so nothing on screen moves and scrollTop is never written while
    // scrolling - on iOS, a scroll position set during a drag or a momentum
    // flick is overridden by the scroll in progress after the content has
    // already moved. Only as many earlier panels go in as the runway can
    // hold; the rest load once it's topped up again (fitInRunway).
    const RUNWAY_PX = 30000;
    let topSpacerHeight = 0;
    function setTopSpacer(height) {
        topSpacerHeight = Math.max(0, height);
        topSpacer.style.height = `${topSpacerHeight}px`;
    }

    // Tops the runway back up (or removes it once the start of the comic
    // is loaded), moving scrollTop by the same amount in the same frame -
    // only while truly idle: no finger on the screen and no scroll event
    // for a second, i.e. no drag or momentum the write could race with.
    const RUNWAY_IDLE_MS = 1000;
    let runwayTimer = null;
    let touching = false;
    // Earlier panels left out because the runway was full - loaded as soon
    // as it's topped up.
    let beforeDeferred = false;
    function runwayTarget() {
        return noMoreBefore ? 0 : RUNWAY_PX;
    }
    function adjustRunway() {
        const delta = runwayTarget() - topSpacerHeight;
        if (!delta) return;
        if (loadingMore || jumping || touching) {
            scheduleRunwayAdjust();
            return;
        }
        const scrollTop = feed.scrollTop;
        setTopSpacer(topSpacerHeight + delta);
        feed.scrollTop = scrollTop + delta;
        if (beforeDeferred && delta > 0) {
            beforeDeferred = false;
            loadMore('before');
        }
    }

    // The earlier panels (nearest the loaded top first) whose height fits
    // in the runway, computed from their known sizes before inserting.
    function fitInRunway(panels) {
        const gap = parseFloat(getComputedStyle(feed).rowGap) || 0;
        const fitting = [];
        let used = 0;
        for (let i = panels.length - 1; i >= 0; i--) {
            const p = panels[i];
            const height = p.width && p.height ? Math.min(p.width, feed.clientWidth) * p.height / p.width + gap : 0;
            if (used + height > topSpacerHeight) break;
            used += height;
            fitting.unshift(p);
        }
        return fitting;
    }
    function scheduleRunwayAdjust() {
        clearTimeout(runwayTimer);
        runwayTimer = setTimeout(adjustRunway, RUNWAY_IDLE_MS);
    }
    feed.addEventListener('scroll', scheduleRunwayAdjust, { passive: true });
    feed.addEventListener('touchstart', () => { touching = true; }, { passive: true });
    function touchEnded(e) {
        if (e.touches.length) return;
        touching = false;
        scheduleRunwayAdjust();
    }
    feed.addEventListener('touchend', touchEnded, { passive: true });
    feed.addEventListener('touchcancel', touchEnded, { passive: true });

    // Before the first paint, so it's not a scroll the reader can see.
    setTopSpacer(RUNWAY_PX);

    // The server sends a window centered on the anchor, but the browser
    // just shows it from the top by default - scroll the anchor into view.
    const initialAnchorEl = feed.querySelector(`[data-panel-id="${anchorPanelId}"]`);
    if (initialAnchorEl) scrollElementToTop(initialAnchorEl);

    function afterIsStalled() {
        return noMoreAfterSince !== null && (Date.now() - noMoreAfterSince) < RECHECK_COOLDOWN_MS;
    }

    // Bumped by every rebuild - a load-more response requested before it
    // describes the old feed (its anchor's neighbors, possibly pages away
    // from the new position) and must not be inserted into the new one.
    let feedGeneration = 0;

    async function loadMore(direction) {
        if (loadingMore) return; // checkEdges runs again once it lands
        if (direction === 'before' && noMoreBefore) return;
        if (direction === 'after' && afterIsStalled()) return;

        const anchor = edgePanelId(direction === 'before' ? 'top' : 'bottom');
        if (!anchor) return;

        loadingMore = true;
        setLoading(true);
        const generation = feedGeneration;
        try {
            const params = direction === 'before'
                ? `before=${LOAD_MORE_COUNT}&after=0`
                : `before=0&after=${LOAD_MORE_COUNT}`;
            const res = await fetch(`/reader/${comicId}/scroll-window?anchor=${anchor}&${params}`);
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || generation !== feedGeneration) return;

            // getWindowAround always includes the anchor itself (already
            // mounted) at one end of the returned list - drop it, and
            // anything else already in the feed.
            let newPanels = (direction === 'before' ? data.panels.slice(0, -1) : data.panels.slice(1))
                .filter(p => !feed.querySelector(`[data-panel-id="${p.id}"]`));
            if (!newPanels.length) {
                if (direction === 'before') {
                    // The start of the comic is loaded: the runway above it
                    // goes at the next idle moment, like any runway change.
                    noMoreBefore = true;
                    scheduleRunwayAdjust();
                } else {
                    noMoreAfterSince = Date.now();
                }
                return;
            }
            if (direction === 'after') noMoreAfterSince = null;
            if (direction === 'before') {
                const fitting = fitInRunway(newPanels);
                if (fitting.length < newPanels.length) {
                    beforeDeferred = true;
                    scheduleRunwayAdjust();
                }
                newPanels = fitting;
                if (!newPanels.length) return;
            }

            const frag = document.createDocumentFragment();
            newPanels.forEach(p => frag.appendChild(makeImg(p)));

            if (direction === 'before') {
                // The new panels take exactly their height out of the
                // runway (they were picked to fit), so nothing on screen
                // moves.
                const prevHeight = feed.scrollHeight;
                feed.insertBefore(frag, topSentinel.nextSibling);
                setTopSpacer(topSpacerHeight - (feed.scrollHeight - prevHeight));
                scheduleRunwayAdjust();
            } else {
                feed.insertBefore(frag, bottomSentinel);
            }
            newPanels.forEach(p => observePanel(feed.querySelector(`[data-panel-id="${p.id}"]`)));
        } catch (err) {
            console.error('Failed to load more panels:', err);
        } finally {
            setLoading(false);
            loadingMore = false;
            checkEdges();
        }
    }

    // Loads more whenever a loaded edge is within LOAD_AHEAD_PX of the
    // screen - after every load and on every scroll, so a load that didn't
    // reach far enough is followed by the next one right away. Panels below
    // come first: that's the reading direction.
    function checkEdges() {
        if (loadingMore || jumping) return;
        const feedRect = feed.getBoundingClientRect();
        if (bottomSentinel.getBoundingClientRect().top - feedRect.bottom < LOAD_AHEAD_PX && !afterIsStalled()) {
            loadMore('after');
        } else if (feedRect.top - topSentinel.getBoundingClientRect().bottom < LOAD_AHEAD_PX && !noMoreBefore && !beforeDeferred) {
            loadMore('before');
        }
    }
    let edgeCheckQueued = false;
    feed.addEventListener('scroll', () => {
        if (edgeCheckQueued) return;
        edgeCheckQueued = true;
        requestAnimationFrame(() => {
            edgeCheckQueued = false;
            checkEdges();
        });
    }, { passive: true });
    checkEdges();

    // --- jumps: First/Latest/Resume/Set-Bookmark/Ignore/history-restore get
    // a target from the single-panel nav endpoints, then rebuild the feed
    // centered on it. ---
    async function rebuildFeedAround(panelId) {
        const res = await fetch(`/reader/${comicId}/scroll-window?anchor=${panelId}&before=6&after=6`);
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) return;
        feedGeneration++;

        feed.querySelectorAll('.reader-scroll-panel').forEach(img => {
            panelObserver.unobserve(img);
            unloadObserver.unobserve(img);
            img.remove();
        });
        visibleHeights.clear();
        noMoreBefore = false;
        setTopSpacer(RUNWAY_PX);
        noMoreAfterSince = null;

        const frag = document.createDocumentFragment();
        data.panels.forEach(p => frag.appendChild(makeImg(p)));
        feed.insertBefore(frag, bottomSentinel);
        data.panels.forEach(p => observePanel(feed.querySelector(`[data-panel-id="${p.id}"]`)));

        mostVisiblePanelId = panelId;
        const el = feed.querySelector(`[data-panel-id="${panelId}"]`);
        if (el) scrollElementToTop(el);
    }

    // Returns the response data on success, null otherwise. `apply` puts
    // the feed at the response's panel - by default a full rebuild around it.
    async function jumpTo(url, body = {}, apply = data => rebuildFeedAround(data.panel.id)) {
        setLoading(true);
        // A jump redefines both where we are and whether we're at the
        // bookmark - drop any queued report and ignore in-flight ones.
        cancelPendingReport();
        navGeneration++;
        jumping = true;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.panel) {
                showToast((data && data.error) || 'Navigation failed.', { type: 'error' });
                return null;
            }
            await apply(data);
            lastReportedPanelId = data.panel.id;
            bookmarkPanelId = data.atBookmark ? data.panel.id : null;
            setAtBookmark(!!data.atBookmark);
            if (data.bookmarkHistory) renderHistory(data.bookmarkHistory);
            if (data.bookmarks) renderBookmarks(data.bookmarks);
            return data;
        } catch (err) {
            console.error('Navigation error:', err);
            showToast('Navigation failed - check your connection.', { type: 'error' });
            return null;
        } finally {
            jumping = false;
            setLoading(false);
            checkEdges();
        }
    }

    // Both absent when the bottom bar is hidden (comic/global setting).
    firstBtn?.addEventListener('click', () => jumpTo(`/reader/${comicId}/nav/first`, { panelId: mostVisiblePanelId }));
    latestBtn?.addEventListener('click', () => jumpTo(`/reader/${comicId}/nav/latest`, { panelId: mostVisiblePanelId }));
    resumeBtn.addEventListener('click', () => jumpTo(`/reader/${comicId}/nav/resume`));
    setBookmarkBtn.addEventListener('click', () => jumpTo(`/reader/${comicId}/nav/bookmark`, { panelId: mostVisiblePanelId }));

    // Ignore: same two-click confirm UX as the paged reader. Sends the panel
    // actually on screen right now, not whatever the server last heard.
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

    // Picks up a position the previous page noted on its way out (see
    // flushOnHide) that this page may have been built without. Repeats that
    // report itself - harmless if the beacon already landed (the server
    // then just confirms it's the bookmark) - and moves the feed there
    // before it's shown.
    async function restorePendingPosition() {
        let pending = null;
        try {
            pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
            sessionStorage.removeItem(PENDING_KEY);
        } catch {}
        if (!pending || Date.now() - pending.at > PENDING_MAX_AGE_MS || pending.panelId === anchorPanelId) return;

        feed.style.visibility = 'hidden';
        jumping = true;
        try {
            const res = await fetch(`/reader/${comicId}/scroll-position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ panelId: pending.panelId, fromPanelId: pending.fromPanelId })
            });
            const data = res.ok ? await res.json().catch(() => null) : null;
            if (data) {
                await rebuildFeedAround(pending.panelId);
                lastReportedPanelId = pending.panelId;
                bookmarkPanelId = data.atBookmark ? pending.panelId : null;
                setAtBookmark(data.atBookmark);
            }
        } catch {
            // Stay on what the server rendered.
        } finally {
            jumping = false;
            feed.style.visibility = '';
            checkEdges();
        }
    }
    restorePendingPosition();

    // Takes the ignored page's panels out of the feed where they are, so
    // the next page slides up into their place. The view only moves when
    // the ignored page began above the screen: then the next page lands at
    // the top. Returns false when the next page isn't the feed's very next
    // panel (not loaded yet), so the caller rebuilds.
    function removePageInPlace(pageId, nextPanelId) {
        const imgs = Array.from(feed.querySelectorAll(`.reader-scroll-panel[data-page-id="${pageId}"]`));
        const nextEl = feed.querySelector(`.reader-scroll-panel[data-panel-id="${nextPanelId}"]`);
        if (!imgs.length || !nextEl || imgs[imgs.length - 1].nextElementSibling !== nextEl) return false;

        const feedTop = feed.getBoundingClientRect().top;
        const startedAbove = imgs[0].getBoundingClientRect().top < feedTop;
        imgs.forEach(img => {
            panelObserver.unobserve(img);
            unloadObserver.unobserve(img);
            visibleHeights.delete(Number(img.dataset.panelId));
            img.remove();
        });
        if (startedAbove) scrollElementToTop(nextEl);
        mostVisiblePanelId = nextPanelId;
        return true;
    }

    // The page Ignore means: the one taking up the most of the screen,
    // summed over all its panels - not the page of the single largest
    // panel (mostVisiblePanelId, used for position reports). With the end
    // of one page and the start of the next both showing, their largest
    // panels are often the same size.
    function pageMostOnScreen() {
        const feedRect = feed.getBoundingClientRect();
        const area = new Map();
        let best = null;
        feed.querySelectorAll('.reader-scroll-panel').forEach(img => {
            const r = img.getBoundingClientRect();
            const visible = Math.min(r.bottom, feedRect.bottom) - Math.max(r.top, feedRect.top);
            if (visible <= 0) return;
            const total = (area.get(img.dataset.pageId) || 0) + visible;
            area.set(img.dataset.pageId, total);
            if (!best || total > best.area) best = { pageId: img.dataset.pageId, panelId: Number(img.dataset.panelId), area: total };
        });
        return best;
    }

    async function ignorePage() {
        const target = pageMostOnScreen();
        const ignoredPageId = target ? target.pageId : null;
        const data = await jumpTo(`/reader/${comicId}/nav/ignore`, { panelId: target ? target.panelId : mostVisiblePanelId, fromPanelId: bookmarkPanelId },
            async res => {
                if (!ignoredPageId || !removePageInPlace(ignoredPageId, res.panel.id)) await rebuildFeedAround(res.panel.id);
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

    // Un-ignores, then reloads: the server has already moved this reader
    // back to that panel, and a fresh load rebuilds the feed from scratch
    // with the page back in it - simpler and more reliable than patching
    // the page back into the live feed.
    async function undoIgnore(panelId) {
        // Hold off position reports (including the page-hide beacon the
        // reload would fire) - they'd move the server back off that panel
        // before the reload reads it.
        cancelPendingReport();
        navGeneration++;
        jumping = true;
        setLoading(true);
        try {
            const res = await fetch(`/reader/${comicId}/unignore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ panelId, fromPanelId: bookmarkPanelId })
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
        jumping = false;
        setLoading(false);
    }
});
