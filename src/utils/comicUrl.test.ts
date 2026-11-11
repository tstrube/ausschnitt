import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comicUrlKey } from './comicUrl';

test('the same comic URL written differently has one key', () => {
    const key = comicUrlKey('https://example.com/comic');
    for (const variant of [
        'http://example.com/comic',
        'https://www.example.com/comic',
        'https://Example.COM/comic/',
        'https://example.com/comic//',
        'https://example.com/comic#top'
    ]) {
        assert.equal(comicUrlKey(variant), key, variant);
    }
});

test('a different path, query or host is a different comic', () => {
    const key = comicUrlKey('https://example.com/comic');
    for (const other of [
        'https://example.com/other',
        'https://example.com/Comic',
        'https://example.com/comic?series=2',
        'https://comics.example.com/comic',
        'https://example.org/comic'
    ]) {
        assert.notEqual(comicUrlKey(other), key, other);
    }
});

test('a site root matches with or without its slash', () => {
    assert.equal(comicUrlKey('https://example.com/'), comicUrlKey('http://www.example.com'));
});
