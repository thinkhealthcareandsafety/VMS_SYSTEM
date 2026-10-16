// node --test src/lib/idMatch.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseAadhaarQr, compareNames, checkId, readPrinted, nameTokens, splitCardName, cardKind } from './idMatch.js';

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

test('reads the holder name off a printed card', () => {
  // PAN (2017 on): "Name" label, the name on the line under it; the father's name is not taken.
  const pan = ['INCOME TAX DEPARTMENT GOVT. OF INDIA', 'Permanent Account Number Card', 'ABCDE1234F', 'TH / Name', 'SAGAR ASHOK KADAM', "Fs / Father's Name", 'ASHOK RAO KADAM', 'Date of Birth', '13/07/2005'];
  assert.equal(readPrinted(pan).name, 'SAGAR ASHOK KADAM');
  // Only the father's label was read: no name rather than the wrong one.
  assert.equal(readPrinted(['INCOME TAX DEPARTMENT', "Father's Name", 'ASHOK RAO KADAM', 'Date of Birth']).name, null);
  // Voter ID / licence: the name on the label's own line.
  assert.equal(readPrinted(['ELECTION COMMISSION OF INDIA', "Elector's Name : PRIYA SHAH", "Father's Name : MAHESH SHAH"]).name, 'PRIYA SHAH');
  assert.equal(readPrinted(['Name: RAVI KUMAR Blood Group: O+']).name, 'RAVI KUMAR');
  // Aadhaar without a readable QR: the line above DOB.
  assert.equal(readPrinted(['Government of India', 'xx', 'Vaibhav Sudhakar Pachpute', 'aa fafa/DOB: 03/11/2005', 'MALE']).name, 'Vaibhav Sudhakar Pachpute');
  // Passport: given names and surname.
  assert.equal(readPrinted(['REPUBLIC OF INDIA', 'Surname', 'KADAM', 'Given Name(s)', 'SAGAR ASHOK']).name, 'SAGAR ASHOK KADAM');
  // A misread letter: no name.
  assert.equal(readPrinted(['Name', 'SAGAR ASHOW » ADAM']).name, null);
  assert.equal(readPrinted(['Name', 'SAGAR wADAM']).name, null);
});

test('a name the reader is unsure of, or that runs into glare, is not taken', () => {
  const at = (text, x0, y0, x1, y1, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  const label = [at('Name', 100, 100, 160, 120)];
  assert.equal(readPrinted([label, [at('SAGAR', 100, 130, 180, 150), at('KADAM', 190, 130, 270, 150)]]).name, 'SAGAR KADAM');
  assert.equal(readPrinted([label, [at('SAGAR', 100, 130, 180, 150), at('KADAN', 190, 130, 270, 150, 40)]]).name, null);
  // "KADAM" swallowed into a tall junk box next to the line.
  assert.equal(readPrinted([label, [at('SAGAR', 100, 130, 180, 150), at('ASHOK', 190, 130, 270, 150)], [at('on', 280, 60, 400, 220, 40)]]).name, null);
});

test('the printed name is used for the check and offered to fill in', () => {
  const read = readPrinted(['INCOME TAX DEPARTMENT', 'Name', 'SAGAR ASHOK KADAM', "Father's Name", 'ASHOK KADAM']);
  assert.equal(checkId(read, { firstName: 'Sagar', lastName: 'Kadam' }).status, 'match');
  const wrong = checkId(read, { firstName: 'Neha', lastName: 'Verma' });
  assert.equal(wrong.status, 'mismatch');
  assert.equal(wrong.cardName, 'SAGAR ASHOK KADAM');
});

test('tells which card it is', () => {
  const words = (s) => s.split(/\s+/);
  assert.equal(cardKind(words('INCOME TAX DEPARTMENT GOVT. OF INDIA Permanent Account Number Card')).kind, 'pan');
  assert.equal(cardKind(words('INGUME IAX DEFAKIMENT LHSPKO213K')).kind, 'pan'); // misread words, but the PAN number
  assert.equal(cardKind(words('Indian Union Driving Licence Transport Department')).kind, 'dl');
  assert.equal(cardKind(words('ELECTION COMMISSION OF INDIA IDENTITY CARD')).kind, 'voter');
  assert.equal(cardKind(words('REPUBLIC OF INDIA PASSPORT')).kind, 'passport');
  assert.equal(cardKind(words('Government of India Vaibhav DOB MALE'), { aadhaarNumber: true }).kind, 'aadhaar');
  assert.equal(cardKind(words('Mera Aadhaar Meri Pehchaan')).kind, 'aadhaar');
  // An Aadhaar always wins: never left unmasked because it also says "income".
  assert.equal(cardKind(words('Permanent Account Income'), { qr: true }).kind, 'aadhaar');
  const gov = cardKind(words('Government of India Vaibhav Pachpute MALE'));
  assert.deepEqual([gov.kind, gov.maybeAadhaar], [null, true]);
  assert.equal(cardKind(words('PAN card captured Retake')).kind, null);
});
