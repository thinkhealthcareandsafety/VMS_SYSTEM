// node --test src/lib/tracking.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTracking } from './tracking.js';

test('the tracking number wins over a PIN code, a short code and an order link', () => {
  assert.equal(pickTracking(['110033', 'A12', 'https://shop.example.com/order/7781', '12345678901234']), '12345678901234');
  assert.equal(pickTracking(['400001', 'TBA123456789012']), 'TBA123456789012');
});

test('a QR with JSON or a link gives its AWB field', () => {
  assert.equal(pickTracking(['{"awb":"BD12345678","pin":"110033"}']), 'BD12345678');
  assert.equal(pickTracking(['https://track.example.com/?waybill=DLV7781234']), 'DLV7781234');
});

test('nothing usable: no answer rather than a wrong one', () => {
  assert.equal(pickTracking(['110033', 'hello world', '']), null);
});
