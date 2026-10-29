// node --test src/lib/invoiceRead.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoiceExtras, parseInvoiceText } from './invoiceRead.js';

test('a printed tax invoice: supplier, address, GSTIN, mobile and invoice number', () => {
  const text = `TAX INVOICE                      ORIGINAL FOR RECIPIENT
FRESH FARMS PRODUCE PVT. LTD.
Shop 14, Azadpur Mandi,
New Delhi - 110033
GSTIN : 07AABCF1234K1Z5      Mob: 98111 00011
Invoice No. : FF/2026/0412       Invoice Date : 26-10-2026
Bill To: St. Regis New Delhi
Sr Item  Qty
1  Tomato  50 kg`;
  assert.deepEqual(parseInvoiceText(text), {
    company: 'FRESH FARMS PRODUCE PVT. LTD',
    address: 'Shop 14, Azadpur Mandi, New Delhi - 110033',
    gstin: '07AABCF1234K1Z5',
    mobile: '9811100011',
    invoice: 'FF/2026/0412',
  });
});

test('a delivery challan read with OCR slips: GSTIN look-alikes fixed, challan number, no invoice', () => {
  const text = `DELIVERY CHALLAN
M/s Sharma Hotel Supplies
B-22 Okhla Phase 2, Delhi 110020
GSTIN: O7AAB CS5678 Q1Z9
Challan No: 4471
Contact: +91 87654 32109`;
  const r = parseInvoiceText(text);
  assert.equal(r.company, 'Sharma Hotel Supplies');
  assert.equal(r.address, 'B-22 Okhla Phase 2, Delhi 110020');
  assert.equal(r.gstin, '07AABCS5678Q1Z9');
  assert.equal(r.challan, '4471');
  assert.equal(r.mobile, '8765432109');
  assert.equal(r.invoice, undefined);
});

test('a handwritten bill gives little: only what was read, nothing invented', () => {
  assert.deepEqual(parseInvoiceText('Ramesh\nbill no 23\n9876543210'), { company: 'Ramesh', invoice: '23', mobile: '9876543210' });
  assert.deepEqual(parseInvoiceText(''), {});
  assert.equal(parseInvoiceText('Invoice Date: 12/10/2026').invoice, undefined, 'a date line is not an invoice number');
});

test('a table layout: the invoice number printed under its label is still found', () => {
  const text = `KITCHEN KING TRADERS
Invoice No.    Date
KK-7781        28-10-2026`;
  assert.equal(parseInvoiceText(text).invoice, 'KK-7781');
});

test('vehicle number and goods lines are suggested; totals, tax and the GSTIN are not', () => {
  const text = `FRESH FARMS PRODUCE PVT. LTD.
GSTIN : 07AABCF1234K1Z5
Vehicle No: DL1LAB1234
Sr Item              Qty
1  Tomato            50 kg     40.00   2000.00
2  Eggs              30 Nos
3  Paneer 0402 12 kgs
4  Bananas 2 dozen
Sub Total 4000 kg
CGST 2.5 %`;
  const x = parseInvoiceExtras(text);
  assert.equal(x.vehicle, 'DL1LAB1234');
  assert.deepEqual(x.items, [
    { name: 'Tomato', qty: 50, unit: 'kg' },
    { name: 'Eggs', qty: 30, unit: 'nos' },
    { name: 'Paneer', qty: 12, unit: 'kg' },
    { name: 'Bananas', qty: 24, unit: 'nos' },
  ]);
});

test('nothing invented from a page with no goods or vehicle', () => {
  assert.deepEqual(parseInvoiceExtras('Thank you for your business\nAuthorised signatory'), {});
});
