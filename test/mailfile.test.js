'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const M = require('../src/js/mailfile.js');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));

test('reads an Outlook .msg (unicode, small streams)', () => {
  const m = M.parse('x.msg', fx('mail-unicode.msg'));
  assert.equal(m.subject, 'Re: Acme quote – final numbers');
  assert.equal(m.from, 'Dana Reyes'); assert.equal(m.fromAddr, 'dana.reyes@acme.example');
  assert.equal(m.date, '2026-10-14T15:30:00.000Z'); assert.equal(m.id, '<abc123@acme.example>');
  assert.match(m.body, /hold the price until Nov 30/); assert.ok(!/\r/.test(m.body));
});
test('reads an ANSI .msg whose body is a big stream', () => {
  const m = M.parse('y.msg', fx('mail-ansi-big.msg'));
  assert.equal(m.subject, 'Weekly status'); assert.equal(m.from, 'Sam Ortiz');
  assert.equal(m.body.split('\n').length, 600);
});
test('damaged or foreign files do not throw out of parse callers that guard', () => {
  assert.throws(() => M.parse('z.msg', Buffer.concat([fx('mail-unicode.msg').subarray(0, 300)])));
  assert.equal(M.parse('a.bin', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null);
});
test('reads .eml: encoded subject, quoted-printable, multipart', () => {
  const eml = ['From: "Lee Wong" <lee@x.example>', 'Subject: =?UTF-8?B?Q2Fmw6kgcGxhbg==?=', 'Date: Tue, 14 Oct 2026 10:00:00 -0500', 'Message-ID: <m1@x>', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=C3=A9 on Friday?', '--b1', 'Content-Type: text/html', '', '<p>Caf&eacute;</p>', '--b1--', ''].join('\r\n');
  const m = M.parse('a.eml', Buffer.from(eml));
  assert.equal(m.subject, 'Café plan'); assert.equal(m.from, 'Lee Wong'); assert.equal(m.fromAddr, 'lee@x.example');
  assert.equal(m.body, 'Café on Friday?'); assert.equal(m.date, '2026-10-14T15:00:00.000Z'); assert.equal(m.id, '<m1@x>');
});
test('html-only .eml becomes text', () => {
  const m = M.parse('h.eml', Buffer.from('Subject: Hi\r\nContent-Type: text/html\r\n\r\n<div>Hello<br>there &amp; you</div>'));
  assert.equal(m.body, 'Hello\nthere & you');
});
test('dropped text: headers if present, else first line', () => {
  const a = M.fromText('From: Pat <pat@x.example>\nSent: Monday, October 13, 2026 9:15 AM\nSubject: Budget\n\nNumbers inside');
  assert.equal(a.subject, 'Budget'); assert.equal(a.from, 'Pat'); assert.equal(a.fromAddr, 'pat@x.example'); assert.ok(a.date.startsWith('2026-10-13'));
  assert.equal(M.fromText('Just a thought\nmore').subject, 'Just a thought');
  assert.equal(M.fromText('   '), null);
});
test('subtask line and note text', () => {
  const m = M.parse('x.msg', fx('mail-unicode.msg'));
  assert.equal(M.subtaskTitle(m), 'Email: Re: Acme quote – final numbers (Dana Reyes, Oct 14, 2026)');
  assert.match(M.noteText(m), /^Email: Re: Acme quote[\s\S]*From: Dana Reyes <dana\.reyes@acme\.example>[\s\S]*Date: Oct 14, 2026\n\nHi Jon/);
});
test('new Outlook drag parts: finds the fields in JSON under varied spellings', () => {
  const a = M.fromParts({ maillistitempart: JSON.stringify({ items: [{ ItemId: 'AAMk123', Subject: 'Lunch Friday?', From: { EmailAddress: { Name: 'Kim Ng', Address: 'kim@x.example' } }, DateTimeReceived: '2026-10-19T14:05:00Z', Preview: 'Are you free at noon?' }] }) });
  assert.equal(a.subject, 'Lunch Friday?'); assert.equal(a.from, 'Kim Ng'); assert.equal(a.fromAddr, 'kim@x.example');
  assert.equal(a.date, '2026-10-19T14:05:00.000Z'); assert.equal(a.body, 'Are you free at noon?'); assert.equal(a.id, 'AAMk123');
  const b = M.fromParts({ x: encodeURIComponent(JSON.stringify([{ subject: 'Hi', sender: 'Lee <lee@y.example>', id: 7 }])) });
  assert.equal(b.subject, 'Hi'); assert.equal(b.id, '7');
  assert.equal(M.fromParts({ x: 'not json at all' }), null);
  assert.equal(M.fromParts({}), null);
});
