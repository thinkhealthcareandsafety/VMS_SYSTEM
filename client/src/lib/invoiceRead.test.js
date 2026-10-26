// node --test src/lib/invoiceRead.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoiceText } from './invoiceRead.js';

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
