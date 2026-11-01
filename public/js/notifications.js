// Settings page's "New-page notifications" control: turns Web Push on/off for
// this device and keeps the server's copy of the subscription current.
(() => {
    const toggleBtn = document.getElementById('notifyToggle');
    const testBtn = document.getElementById('notifyTest');
    const status = document.getElementById('notifyStatus');
    if (!toggleBtn) return;

    function unsupported(message) {
        toggleBtn.hidden = true;
        testBtn.hidden = true;
        status.textContent = message;
    }

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    if (!window.isSecureContext) {
        unsupported('Needs HTTPS - see the manual.');
        return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        // iOS only offers push to apps added to the Home Screen.
        unsupported(isIos && !installed
            ? 'On iPhone/iPad, add Ausschnitt to your Home Screen first and turn them on from there.'
            : "This browser doesn't support them.");
        return;
    }

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(res => {
            if (!res.ok) throw new Error(`Request failed: ${res.status}`);
            return res.json();
        });
    }

    function keyToBytes(base64Url) {
        const base64 = (base64Url + '='.repeat((4 - base64Url.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    }

    function sameKey(buffer, bytes) {
        if (!buffer) return false;
        const a = new Uint8Array(buffer);
        return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
    }

    let subscription = null;

    function render() {
        toggleBtn.hidden = false;
        toggleBtn.textContent = subscription ? 'Turn off' : 'Turn on';
        testBtn.hidden = !subscription;
        status.textContent = subscription ? 'On for this device'
            : Notification.permission === 'denied' ? 'Blocked in this browser’s settings'
            : 'Off for this device';
        toggleBtn.disabled = !subscription && Notification.permission === 'denied';
    }

    async function getServerKey() {
        const res = await fetch('/push/key');
        return keyToBytes((await res.json()).publicKey);
    }

    async function init() {
        const registration = await navigator.serviceWorker.ready;
        subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            // A subscription made against different server keys (e.g. the
            // server's data was reset) can never receive anything - renew it.
            const key = await getServerKey();
            if (!sameKey(subscription.options.applicationServerKey, key)) {
                await subscription.unsubscribe();
                subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            }
            await postJson('/push/subscribe', { subscription: subscription.toJSON() });
        }
        render();
    }

    toggleBtn.addEventListener('click', async () => {
        toggleBtn.disabled = true;
        try {
            if (subscription) {
                await postJson('/push/unsubscribe', { endpoint: subscription.endpoint });
                await subscription.unsubscribe();
                subscription = null;
            } else {
                // Must run straight from the click - browsers only show the
                // permission prompt in response to a user gesture.
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    const registration = await navigator.serviceWorker.ready;
                    subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: await getServerKey()
                    });
                    await postJson('/push/subscribe', { subscription: subscription.toJSON() });
                }
            }
        } catch (err) {
            console.error(err);
            showToast("Couldn't change notification settings.", { type: 'error' });
        }
        toggleBtn.disabled = false;
        render();
    });

    testBtn.addEventListener('click', async () => {
        try {
            const result = await postJson('/push/test');
            if (!result.sent) showToast('No notification could be sent to this device.', { type: 'error' });
        } catch {
            showToast("Couldn't send a test notification.", { type: 'error' });
        }
    });

    init().catch(err => {
        console.error(err);
        unsupported("Couldn't check notification status.");
    });
})();
