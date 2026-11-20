import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedNtfyUrl, parseNtfyUrl } from './ntfy';

test('splits an ntfy topic URL into the server and the topic', () => {
    assert.deepEqual(parseNtfyUrl('https://ntfy.sh/ausschnitt-x7Kq_2'), { base: 'https://ntfy.sh/', topic: 'ausschnitt-x7Kq_2' });
    assert.deepEqual(parseNtfyUrl(' http://192.168.1.5:8080/comics '), { base: 'http://192.168.1.5:8080/', topic: 'comics' });
    assert.deepEqual(parseNtfyUrl('https://example.org/ntfy/comics/'), { base: 'https://example.org/ntfy/', topic: 'comics' });
});

test('rejects anything that is not a plain topic URL', () => {
    for (const raw of [
        '', 'ntfy.sh/comics', 'ftp://ntfy.sh/comics', 'https://ntfy.sh/', 'https://ntfy.sh/com ics',
        'https://ntfy.sh/comics?x=1', 'https://ntfy.sh/comics#a', 'https://user:pw@ntfy.sh/comics', 42, undefined
    ]) {
        assert.equal(parseNtfyUrl(raw), null, String(raw));
    }
});

test('a private-network ntfy server is only for accounts that may use one', async () => {
    assert.equal(await isAllowedNtfyUrl('http://192.168.1.5:8080/comics', true), true);
    assert.equal(await isAllowedNtfyUrl('http://192.168.1.5:8080/comics', false), false);
    assert.equal(await isAllowedNtfyUrl('http://127.0.0.1/comics', false), false);
});
