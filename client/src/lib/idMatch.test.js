// node --test src/lib/idMatch.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseAadhaarQr, compareNames, checkId, readPrinted, nameTokens, splitCardName } from './idMatch.js';

// Builds a QR payload the way UIDAI does: 0xFF-separated fields, gzip, as one big decimal number.
function secureQr(fields) {
  const parts = [];
  for (const f of fields) { parts.push(Buffer.from(f, 'latin1'), Buffer.from([255])); }
  parts.push(Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 73 + 11) % 251))); // photo + signature stand-in
  const hex = gzipSync(Buffer.concat(parts)).toString('hex');
  return BigInt(`0x${hex}`).toString(10);
}

test('reads a V2 Secure QR', async () => {
  const r = await parseAadhaarQr(secureQr(['V2', '3', '482120190101123456789', 'Ravi Kumar Sharma', '01-01-1990', 'M', 'S/O Ram', 'New Delhi']));
  assert.deepEqual([r.name, r.gender, r.last4, r.dob], ['Ravi Kumar Sharma', 'male', '4821', '01-01-1990']);
});

test('reads a V1 Secure QR and the old XML QR', async () => {
  const v1 = await parseAadhaarQr(secureQr(['2', '991020190101000000000', 'Pooja Devi', '1995', 'F']));
  assert.equal(v1.name, 'Pooja Devi'); assert.equal(v1.gender, 'female'); assert.equal(v1.last4, '9910');
  const xml = await parseAadhaarQr('<?xml version="1.0"?><PrintLetterBarcodeData uid="123412341234" name="Anil K" gender="M" yob="1980"/>');
  assert.equal(xml.name, 'Anil K'); assert.equal(xml.last4, '1234');
  assert.equal(await parseAadhaarQr('https://example.com'), null);
  assert.equal(await parseAadhaarQr('9'.repeat(300)), null);
});

test('name variants', () => {
  const card = nameTokens('MOHAMMED IRFAN KHAN');
  assert.equal(compareNames('Md Irfan Khan', card).status, 'match');
  assert.equal(compareNames('Mohd. Irfan', card).status, 'match');
  assert.equal(compareNames('Irfan', card).status, 'partial');
  assert.equal(compareNames('Laxmi Sarma', nameTokens('Lakshmi Sharma')).status, 'match');
  assert.equal(compareNames('Puja Singh', nameTokens('Pooja Singh')).status, 'match');
  assert.equal(compareNames('Ravikumar', nameTokens('Ravi Kumar')).status, 'match');
  assert.equal(compareNames('Kumar Ravi', nameTokens('Ravi Kumar')).status, 'match');
  assert.equal(compareNames('R Kumar', nameTokens('Ravi Kumar')).status, 'match');
  assert.equal(compareNames('Suresh Gupta', nameTokens('Ravi Kumar')).status, 'mismatch');
  assert.equal(compareNames('Ram', nameTokens('Raj Malhotra')).status, 'mismatch');
});

test('full check: QR, printed card, gender, tamper', () => {
  const qr = { source: 'qr', name: 'Ravi Kumar', gender: 'male', last4: '4821' };
  assert.equal(checkId(qr, { firstName: 'Ravi', lastName: 'Kumar', gender: 'male' }).status, 'match');
  assert.equal(checkId(qr, { firstName: 'Ravi', lastName: 'Kumar', gender: 'female' }).status, 'mismatch');
  assert.equal(checkId({ ...qr, ocrLast4: '1111' }, { firstName: 'Ravi', lastName: 'Kumar', gender: 'male' }).tamper, true);
  const pan = readPrinted(['INCOME TAX DEPARTMENT GOVT. OF INDIA', 'Permanent Account Number Card', 'ABCDE1234F', 'Name', 'PRIYA SHAH', "Father's Name", 'MAHESH SHAH', 'Date of Birth 01/02/1992']);
  assert.equal(checkId(pan, { firstName: 'Priya', lastName: 'Shah', gender: 'female' }).status, 'match');
  assert.equal(checkId(pan, { firstName: 'Neha', lastName: 'Verma', gender: 'female' }).status, 'mismatch');
  assert.equal(checkId(readPrinted(['', 'x']), { firstName: 'A', lastName: 'B' }).status, 'unread');
  assert.deepEqual(splitCardName('RAVI KUMAR SHARMA'), { firstName: 'Ravi', lastName: 'Kumar Sharma' });
});
