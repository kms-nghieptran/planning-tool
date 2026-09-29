'use strict';
/**
 * mail.test.js — the SMTP client and the MIME builder.
 *
 * WHY THIS SUITE EXISTS
 *
 * This is the only code in the tool whose output leaves the building. A bug
 * in the Capacity grid is a wrong number he can see; a bug here is a client
 * receiving a truncated report, a corrupt PDF, or a subject line reading
 * "Coverage â€" Katalon Ruby" — none of which look wrong from this end,
 * because from this end the send returned 250 OK.
 *
 * EVERY CHECK RUNS AGAINST A FAKE SMTP SERVER ON LOOPBACK. Nothing here
 * opens a socket to the internet, and nothing here can send mail to a real
 * person, however the config is filled in. The fake is also the only way to
 * assert the thing that actually matters — the exact bytes on the wire.
 *
 * Run: node test/mail.test.js
 */

const assert = require('node:assert');
const net = require('node:net');
const smtp = require('../lib/smtp');
const mime = require('../lib/mime');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe mail path — SMTP on the wire, MIME on the page\n');

/* ── a fake SMTP server ───────────────────────────────────────────────────
   It speaks just enough to be refused by, or to accept, a real message, and
   it records every line it was sent. `script` lets a check make the server
   behave badly on one command, which is the only way to test that a refusal
   reaches the user with the server's own words in it. */

function fakeServer(opts = {}) {
  const log = { lines: [], data: [], mailFrom: null, rcpt: [] };
  const script = opts.script || {};
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    const say = (s) => sock.write(`${s}\r\n`);
    say(script.greeting || '220 fake.smtp ESMTP ready');

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\r\n');
      buf = parts.pop();
      for (const line of parts) {
        if (inData) {
          /* THE DOT ON ITS OWN ENDS THE MESSAGE — the same rule the client
             has to stuff against. The fake implements it for real so that a
             client which forgot to stuff produces a visibly short body here
             rather than a mysterious failure. */
          if (line === '.') {
            inData = false;
            say(script.data === 'reject' ? '554 5.7.1 Message rejected by policy' : '250 2.0.0 OK queued as ABC123');
            continue;
          }
          log.data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        log.lines.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) {
          /* MULTI-LINE ON PURPOSE. EHLO's reply is always several lines, and
             a client that reads only the first one never learns whether
             STARTTLS or AUTH PLAIN exist. */
          say('250-fake.smtp at your service');
          say('250-SIZE 35882577');
          if (script.noAuth) say('250-8BITMIME'); else say('250-AUTH LOGIN PLAIN');
          say('250 ENHANCEDSTATUSCODES');
        } else if (up.startsWith('AUTH LOGIN')) {
          say('334 VXNlcm5hbWU6');
        } else if (up.startsWith('AUTH PLAIN')) {
          say(script.auth === 'reject' ? '535 5.7.8 Username and Password not accepted' : '235 2.7.0 Accepted');
        } else if (up.startsWith('MAIL FROM')) {
          log.mailFrom = line;
          say('250 2.1.0 OK');
        } else if (up.startsWith('RCPT TO')) {
          log.rcpt.push(line);
          say(script.rcpt && line.includes(script.rcpt) ? '550 5.1.1 No such user here' : '250 2.1.5 OK');
        } else if (up === 'DATA') {
          inData = true;
          say('354 Go ahead');
        } else if (up === 'QUIT') {
          say('221 2.0.0 Bye');
          sock.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // a base64 AUTH argument
          if (log.lines.filter(l => /^[A-Za-z0-9+/=]+$/.test(l)).length === 1) say('334 UGFzc3dvcmQ6');
          else say(script.auth === 'reject' ? '535 5.7.8 Username and Password not accepted' : '235 2.7.0 Accepted');
        } else {
          say('250 OK');
        }
      }
    });
    sock.on('error', () => {});
  });
  return { server, log };
}

/* ── PRETENDING TO BE ENCRYPTED ───────────────────────────────────────────
   The client refuses to authenticate over a plaintext socket, which is the
   point of one of the checks below — so the AUTH path cannot be exercised
   against a plain fake. A genuinely TLS fake needs a certificate, and
   generating one at test time is a pile of X.509 for no extra coverage: the
   handshake is Node's, not ours.

   So `connect` is injected. The socket is plain, and the client is told the
   connection is already secure — which is exactly the shape of a real
   implicit-TLS connection on 465, and exercises every command after it. What
   this cannot check is the handshake, and nothing here claims to. */
const asSecure = (o) => {
  const sock = net.connect({ host: o.host, port: o.port });
  sock.once('connect', () => sock.emit('secureConnect'));
  Object.defineProperty(sock, 'encrypted', { value: true, configurable: true });
  return sock;
};

/** Run one send against a fresh fake, and hand back what the server saw. */
function withServer(script, fn) {
  return new Promise((resolve, reject) => {
    const { server, log } = fakeServer({ script });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      let out = null, err = null;
      try { out = await fn({ host: '127.0.0.1', port, secure: false }, log); } catch (e) { err = e; }
      server.close(() => (err && !script.expectError ? reject(err) : resolve({ log, out, err })));
    });
    server.on('error', reject);
  });
}

const MSG = (over = {}) => mime.build({
  from: 'Nghiep Tran <nghieptran@kms-technology.com>',
  to: ['client@example.com'],
  subject: 'Overall Coverage',
  text: 'Here is this week\'s report.',
  ...over,
});

/* ── the wire ─────────────────────────────────────────────────────────── */

check('A MESSAGE GOES OUT, and the server sees a real conversation', async () => {
  const { log, out } = await withServer({}, (cfg) => {
    const m = MSG();
    return smtp.send({ ...cfg, secure: true, user: 'u', pass: 'p', from: 'nghieptran@kms-technology.com' },
      { ...m, from: 'nghieptran@kms-technology.com' }, { connect: asSecure });
  });
  const said = log.lines.join(' | ');
  assert.match(said, /EHLO/, 'the client never introduced itself');
  assert.match(said, /AUTH/, 'the client never authenticated');
  assert.match(said, /MAIL FROM:<nghieptran@kms-technology\.com>/, 'no envelope sender');
  assert.match(said, /RCPT TO:<client@example\.com>/, 'no envelope recipient');
  assert.match(said, /DATA/, 'the message body was never sent');
  assert.deepStrictEqual(out.accepted, ['client@example.com']);
});

check('A MULTI-LINE REPLY IS READ WHOLE, not one line at a time', async () => {
  /* EHLO answers with one line per extension. A client that resolves on the
     first line reads "250-fake.smtp at your service" as the whole reply, never
     learns AUTH exists, and then sends AUTH anyway or skips it — both of
     which fail against a real server on a different day. */
  const r = smtp.parseReply(['250-hello', '250-SIZE 100', '250 AUTH LOGIN PLAIN']);
  assert.strictEqual(r.code, 250);
  assert.match(r.text, /AUTH LOGIN PLAIN/, 'the extension list was lost');
  assert.ok(!smtp.isComplete('250-hello'), 'a continuation line was treated as the end of the reply');
  assert.ok(smtp.isComplete('250 done'), 'the final line was not recognised');
});

check('A LINE THAT IS JUST A DOT DOES NOT END THE MESSAGE EARLY', async () => {
  /* The bug that does not look like one: the mail is DELIVERED, truncated at
     the dot, and everything after it is fed to the server as commands. A
     template with a bullet or a signature separator is one keystroke away. */
  const body = 'First paragraph.\n.\nSecond paragraph after a lone dot.';
  const { log } = await withServer({}, (cfg) => {
    const m = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: body });
    return smtp.send({ ...cfg, from: 'a@b.com' }, m);
  });
  const wire = log.data.join('\n');
  assert.match(wire, /Content-Type: multipart\/alternative/, 'the body never arrived');
  // The base64 text part decodes back to exactly what was typed.
  const b64 = wire.split('Content-Transfer-Encoding: base64')[1].split('\r\n\r\n')[0];
  const decoded = Buffer.from(b64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
  assert.strictEqual(decoded, body, 'the body was truncated or mangled on the wire');
});

check('AND THE STUFFING IS EXACTLY THE PROTOCOL\'S RULE', async () => {
  assert.strictEqual(smtp.stuff('.'), '..', 'a lone dot was not stuffed');
  assert.strictEqual(smtp.stuff('.hidden'), '..hidden', 'a leading dot was not stuffed');
  assert.strictEqual(smtp.stuff('a.b'), 'a.b', 'a dot inside a line was stuffed, which corrupts it');
  assert.strictEqual(smtp.stuff('one\ntwo'), 'one\r\ntwo', 'a bare newline survived into DATA');
  assert.strictEqual(smtp.stuff('one\r\ntwo'), 'one\r\ntwo', 'CRLF was doubled');
});

check('A REFUSAL ARRIVES WITH THE SERVER\'S OWN WORDS', async () => {
  /* "Send failed" is not actionable. "535 Username and Password not accepted"
     tells him to go and make an app password, which is the actual fix. */
  const { err } = await withServer({ auth: 'reject', expectError: true }, (cfg) =>
    smtp.send({ ...cfg, secure: true, user: 'u', pass: 'wrong', from: 'a@b.com' }, MSG(), { connect: asSecure }));
  assert.ok(err, 'a rejected password was reported as a successful send');
  assert.match(err.message, /535/, 'the reply code is not in the message');
  assert.match(err.message, /Username and Password not accepted/, "the server's explanation was thrown away");
});

check('AND SO DOES A REFUSED RECIPIENT, naming the address', async () => {
  const { err } = await withServer({ rcpt: 'ghost@example.com', expectError: true }, (cfg) =>
    smtp.send({ ...cfg, from: 'a@b.com' },
      mime.build({ from: 'a@b.com', to: ['ghost@example.com'], subject: 'S', text: 'x' })));
  assert.ok(err, 'a refused recipient was reported as delivered');
  assert.match(err.message, /ghost@example\.com/, 'the message does not say which address was refused');
  assert.match(err.message, /550|No such user/, "and does not carry the server's reason");
});

check('A REFUSED MESSAGE IS NOT REPORTED AS SENT', async () => {
  /* The last thing that can go wrong, and the easiest to miss: every command
     succeeded and the body was refused at the end. */
  const { err } = await withServer({ data: 'reject', expectError: true }, (cfg) =>
    smtp.send({ ...cfg, from: 'a@b.com' }, MSG()));
  assert.ok(err, 'a policy rejection after DATA was swallowed');
  assert.match(err.message, /554|rejected/, 'the rejection is not explained');
});

check('THE PASSWORD IS NEVER SENT IN THE CLEAR', async () => {
  /* Base64 is not encryption. A client that authenticates over a plaintext
     socket because the server did not offer STARTTLS has put his app password
     on the wire, and nothing on screen would say so. */
  const { err } = await withServer({ noAuth: true, expectError: true }, (cfg) =>
    smtp.send({ ...cfg, user: 'u', pass: 'p', from: 'a@b.com' }, MSG()));
  assert.ok(err, 'the password was sent over an unencrypted connection');
  assert.match(err.message, /STARTTLS|unencrypted/i, 'and the refusal does not explain why');
});

check('A GOOGLE APP PASSWORD WORKS WITH ITS SPACES STILL IN IT', () => {
  /* THE BUG THIS EXISTS FOR, and it cost a real evening. Google shows an app
     password as four groups of four — `abcd efgh ijkl mnop` — and selecting
     it copies the spaces. Nineteen characters go into the settings field, the
     server answers `535 Username and Password not accepted`, and that message
     says nothing whatsoever about formatting: it reads as the wrong password,
     so the next move is always to generate another one, which has the same
     spaces. */
  assert.strictEqual(smtp.appPassword('abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  assert.strictEqual(smtp.appPassword('  abcd efgh ijkl mnop  '), 'abcdefghijklmnop');
  assert.strictEqual(smtp.appPassword('abcd\tefgh ijkl mnop'), 'abcdefghijklmnop');
  assert.strictEqual(smtp.appPassword('abcdefghijklmnop'), 'abcdefghijklmnop', 'one without spaces is untouched');
});

check('BUT A REAL PASSWORD KEEPS ITS SPACES — the dangerous half of that fix', () => {
  /* Stripping whitespace from every password would fix the app-password case
     and silently break any passphrase containing a space — unauthenticable,
     and INVISIBLE, because the stored value is never displayed anywhere. That
     is a worse bug than the one being fixed, so the rule is narrow: take the
     spaces out only when what is left is exactly sixteen alphanumerics, which
     is the shape of a Google or Microsoft app password and very little else. */
  assert.strictEqual(smtp.appPassword('correct horse battery staple'), 'correct horse battery staple');
  assert.strictEqual(smtp.appPassword('my pass word'), 'my pass word', 'twelve characters, not sixteen');
  assert.strictEqual(smtp.appPassword('a b c d e f g h i j k l m n o'), 'a b c d e f g h i j k l m n o',
    'fifteen letters — one short, and still a real password');
  assert.strictEqual(smtp.appPassword('abcd efgh ijkl mn-p'), 'abcd efgh ijkl mn-p',
    'a hyphen means it is not an app password');
  assert.strictEqual(smtp.appPassword(''), '');
  assert.strictEqual(smtp.appPassword(null), '');
});

check('AND THE STRIPPED PASSWORD IS WHAT REACHES THE SERVER', () => {
  /* The unit above proves the function; this proves it is actually WIRED to
     AUTH. Normalising at the point of authentication rather than only on save
     is what repairs a config already stored with the spaces in it — otherwise
     the fix helps the next person to type one and leaves the current settings
     broken with nothing on screen to explain why. */
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'smtp.js'), 'utf8');
  const auth = src.slice(src.indexOf('if (cfg.user)'), src.indexOf('MAIL FROM:'));
  assert.ok(/appPassword\(cfg\.pass\)/.test(auth), 'AUTH does not normalise the password');
  assert.ok(!/b64\(cfg\.pass/.test(auth), 'the raw cfg.pass is still being sent somewhere in AUTH');
});

check('NO RECIPIENTS IS A REFUSAL, not an empty send', async () => {
  await assert.rejects(
    () => smtp.send({ host: '127.0.0.1', port: 1 }, { raw: 'x', to: [] }),
    /No recipients/);
  await assert.rejects(
    () => smtp.send({ host: '' }, { raw: 'x', to: ['a@b.com'] }),
    /mail\.host/);
});

/* ── the message ──────────────────────────────────────────────────────── */

check('THE PDF ARRIVES AS AN ATTACHMENT, intact', async () => {
  /* Round-tripped rather than pattern-matched: the bytes that come out of the
     base64 have to be the bytes that went in, or the client opens a damaged
     file and there is nothing on this end to see. */
  const pdf = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\nbinary\x00\x01\x02 bytes here', 'binary');
  const m = mime.build({
    from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'body',
    attachments: [{ filename: 'coverage.pdf', content: pdf, contentType: 'application/pdf' }],
  });
  assert.match(m.raw, /Content-Type: multipart\/mixed/, 'nothing was attached');
  assert.match(m.raw, /Content-Disposition: attachment; filename="coverage\.pdf"/,
    'the attachment is not marked as one, so some clients render it inline and it never appears as a file');

  const part = m.raw.split('application/pdf')[1].split('\r\n\r\n')[1].split('\r\n--')[0];
  const back = Buffer.from(part.replace(/\r\n/g, ''), 'base64');
  assert.strictEqual(back.toString('binary'), pdf.toString('binary'), 'the PDF was corrupted in transit');
});

check('AND NO LINE IS LONG ENOUGH TO BE FOLDED BY A SERVER', async () => {
  /* SMTP's limit is 1000 octets. Over it the server may reject the message or
     fold it itself — and a fold inside base64 destroys the attachment. */
  const pdf = Buffer.alloc(9000, 0xab);
  const m = mime.build({
    from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'x'.repeat(4000),
    attachments: [{ filename: 'big.pdf', content: pdf, contentType: 'application/pdf' }],
  });
  const lines = m.raw.split('\r\n');
  const worst = lines.reduce((n, l) => Math.max(n, Buffer.byteLength(l, 'utf8')), 0);
  assert.ok(worst <= 998, `the longest line is ${worst} octets — SMTP's limit is 998`);

  /* AND THE BASE64 SPECIFICALLY. The whole-message check above passes on a
     long header, which is legal; what must not happen is an unwrapped
     attachment, because a fold the server inserts inside base64 corrupts the
     PDF. Measured on the encoded lines alone. */
  const b64lines = lines.filter(l => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(l));
  assert.ok(b64lines.length > 50, `fixture check: only ${b64lines.length} encoded lines`);
  const widest = b64lines.reduce((n, l) => Math.max(n, l.length), 0);
  assert.strictEqual(widest, mime.WRAP, `base64 is wrapped at ${widest}, not ${mime.WRAP}`);
});

check('A NON-ASCII SUBJECT SURVIVES', async () => {
  /* "Coverage — Katalon Ruby" has an em dash and his colleagues' names have
     diacritics. Raw UTF-8 in a header is not legal: it arrives as mojibake or
     gets the message refused. The body's charset does nothing for this. */
  const m = mime.build({
    from: 'a@b.com', to: ['c@d.com'], text: 'x',
    subject: 'Coverage — Katalon Ruby · tuần này',
  });
  const line = m.raw.split('\r\n').find(l => l.startsWith('Subject:'));
  assert.ok(!/[^\x20-\x7E]/.test(line), `the subject went out as raw UTF-8: ${line}`);
  assert.match(line, /=\?UTF-8\?B\?/, 'the subject is not an encoded-word');
  const decoded = line.replace('Subject: ', '')
    .split(/\s+/)
    .map(w => (w.startsWith('=?') ? Buffer.from(w.slice(10, -2), 'base64').toString('utf8') : w))
    .join('');
  assert.match(decoded, /Coverage/, 'the subject does not decode back to itself');
  assert.match(decoded, /tuần/, 'the diacritics were lost');
});

check('AND AN ASCII SUBJECT IS LEFT ALONE', async () => {
  const m = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'Weekly coverage', text: 'x' });
  assert.match(m.raw, /Subject: Weekly coverage\r\n/, 'a plain subject was needlessly encoded');
});

check('A NEWLINE CANNOT CLIMB OUT OF A FIELD INTO A HEADER', async () => {
  /* Header injection. Every one of these fields is a text box on a screen,
     and a pasted value with a newline in it could otherwise add a Bcc nobody
     typed — to a mail going to a client. */
  const m = mime.build({
    from: 'Real Name\r\nBcc: sneaky@evil.com <a@b.com>',
    to: ['c@d.com'],
    subject: 'Hello\r\nBcc: also@evil.com',
    text: 'x',
  });
  /* THE PROPERTY IS "NO HEADER WAS INJECTED", not "the text vanished". The
     newline is flattened to a space, so the attempt survives as visible
     nonsense INSIDE the display name — which is the right outcome: nothing
     was silently dropped, and nothing became a header. */
  const headBlock = m.raw.split('\r\n\r\n')[0];
  const injected = headBlock.split('\r\n').filter(l => /^(bcc|cc|to|from|subject):/i.test(l));
  assert.strictEqual(injected.filter(l => /^bcc:/i.test(l)).length, 0,
    'a Bcc header was injected through a field');
  assert.strictEqual(injected.filter(l => /^from:/i.test(l)).length, 1,
    'the From header was split in two');
  assert.strictEqual(injected.filter(l => /^subject:/i.test(l)).length, 1,
    'the Subject header was split in two');

  /* AND THE DISPLAY NAME IS QUOTED, because it now contains a colon and an
     @ — loose in an unquoted name those are not legal, and parsers disagree
     about where the address then begins. */
  const from = headBlock.split('\r\n').find(l => /^from:/i.test(l));
  assert.match(from, /^From: "[^"]*" <a@b\.com>$/, `the From name was not quoted: ${from}`);
});

check('BOTH A PLAIN AND AN HTML BODY GO', async () => {
  /* Some clients, some filters and anything read on a watch take the plain
     part. HTML only means a blank message for them. */
  const m = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'Line one\n\nLine two' });
  assert.match(m.raw, /multipart\/alternative/, 'only one body was sent');
  assert.match(m.raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(m.raw, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(mime.textToHtml('a\n\nb'), /<p[^>]*>a<\/p>/, 'the paragraphs he typed were not kept');
  assert.match(mime.textToHtml('a & <b>'), /&amp;/, 'the body was not escaped into the HTML part');
});

check('NOTHING ATTACHED MEANS NO PAPERCLIP', async () => {
  /* A multipart/mixed of one is legal, and some clients draw an attachment
     indicator for it — on a mail with no attachment, which the client then
     goes looking for. */
  const m = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'x' });
  assert.ok(!/multipart\/mixed/.test(m.raw), 'an empty mixed wrapper was added');
  const m2 = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'x', attachments: [{ filename: 'e.pdf', content: Buffer.alloc(0) }] });
  assert.ok(!/multipart\/mixed/.test(m2.raw), 'a zero-byte attachment produced a paperclip');
});

check('THE BOUNDARY CANNOT OCCUR IN THE CONTENT', async () => {
  /* If it did, the message splits in the wrong place and the attachment is
     destroyed. Random rather than a fixed string makes that impossible
     instead of unlikely. */
  const a = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'x' });
  const b = mime.build({ from: 'a@b.com', to: ['c@d.com'], subject: 'S', text: 'x' });
  const at = (m) => (m.raw.match(/boundary="([^"]+)"/) || [])[1];
  assert.ok(at(a), 'no boundary at all');
  assert.notStrictEqual(at(a), at(b), 'the boundary is a constant, so content can collide with it');
  assert.notStrictEqual(a.messageId, b.messageId, 'two messages share a Message-ID');
});

check('A BAD ADDRESS IS REFUSED BEFORE ANYTHING IS SENT', async () => {
  assert.throws(() => mime.build({ from: 'a@b.com', to: ['not an address'], subject: 'S', text: 'x' }),
    /do not look like email addresses/);
  assert.throws(() => mime.build({ from: 'a@b.com', to: [], subject: 'S', text: 'x' }),
    /at least one recipient/);
  for (const good of ['a@b.com', 'Nghiep <n@kms-technology.com>', 'x.y+z@sub.domain.co.uk']) {
    assert.ok(mime.isEmail(good), `${good} was rejected`);
  }
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com']) {
    assert.ok(!mime.isEmail(bad), `"${bad}" was accepted as an address`);
  }
});

check('A TYPED RECIPIENT LIST SPLITS ON WHAT PEOPLE ACTUALLY TYPE', async () => {
  assert.deepStrictEqual(mime.parseList('a@b.com, c@d.com;e@f.com\ng@h.com'),
    ['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com']);
  assert.deepStrictEqual(mime.parseList('  a@b.com ,, '), ['a@b.com'],
    'a trailing comma produced an empty recipient');
  assert.deepStrictEqual(mime.parseList(''), []);
});

/* ── THE PDF, AND THE WORDS AROUND IT ─────────────────────────────────────
 *
 * Chrome is not launched here. What these check is everything around it: the
 * arguments it would be given, and — more importantly — that a run which
 * produces nothing useful is reported as a failure rather than attached to a
 * client's email as an empty file.
 */

const pdfr = require('../lib/pdf-render');
const rmail = require('../lib/report-mail');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/** A fake Chrome that writes whatever the test says it writes, then exits. */
const fakeChrome = (write) => (bin, args) => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const out = (args.find(a => a.startsWith('--print-to-pdf=')) || '').slice('--print-to-pdf='.length);
  setImmediate(() => {
    try { write(out, child); } catch { /* the test wants a failure */ }
    child.emit('close', 0);
  });
  return child;
};

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-t-')), 'r.pdf');
const REAL_PDF = (f) => fs.writeFileSync(f, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4000, 0x20)]));

check('CHROME IS ASKED FOR THE RIGHT THING', async () => {
  /* REWRITTEN WHEN THE RENDERER STOPPED PRINTING BY FLAG.
     The previous version of this check asserted `--print-to-pdf` and
     `--virtual-time-budget`, and it passed right up until the day the feature
     hung for sixty seconds on his machine and sent nothing — because the
     flags WERE correct and the mechanism was not. Virtual time waits for the
     network, so one stuck request means the budget is never spent and the
     print never happens. The renderer now waits for the page to say it has
     finished and prints over the DevTools protocol, so the flags that matter
     are different ones. What that mechanism actually does under a hanging
     page, a broken view and a half-drawn one is checked against a real
     browser in `test/pdf-render.test.js`; this stays here for the two
     properties that are about his MACHINE rather than about the protocol. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pdf-render.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /--headless/, 'not headless, so it would open a window on his screen');
  /* A LOCKED PROFILE is what a second Chrome hits when he already has one
     open — which is whenever he is actually at the machine. */
  assert.match(code, /--user-data-dir=/, 'it would refuse to start while his own Chrome is open');
  /* PORT 0. A fixed debugging port attaches to whatever is already on it —
     his own DevTools session, or a second copy of this tool — and that does
     not fail, it renders the wrong page. */
  assert.match(code, /--remote-debugging-port=0/, 'a fixed port would collide with his own Chrome');
});

check('AN EMPTY OR STUB RENDER IS A FAILURE, not an attachment', async () => {
  /* The three ways a render "succeeds" and produces something a client must
     never receive. These used to be driven through a fake Chrome, which the
     protocol rewrite made impossible; the checks are pointed at the
     validation itself instead, which is sharper anyway — it was always the
     thing under test. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-verify-'));
  const at = (name) => path.join(dir, name);

  assert.throws(() => pdfr.verify(at('never-written.pdf')),
    /produced no PDF/, 'a missing file was reported as a successful render');

  fs.writeFileSync(at('stub.pdf'), '%PDF-1.7\n');
  assert.throws(() => pdfr.verify(at('stub.pdf')),
    /only \d+ bytes/, 'a stub PDF of a half-loaded page was accepted');

  fs.writeFileSync(at('notpdf.pdf'), Buffer.alloc(4000, 0x41));
  assert.throws(() => pdfr.verify(at('notpdf.pdf')),
    /not a PDF/, 'a file that is not a PDF was accepted');

  fs.writeFileSync(at('real.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4000, 0x20)]));
  assert.strictEqual(pdfr.verify(at('real.pdf')), 4009, 'a real PDF was refused');
});

check('AND A MISSING CHROME SAYS WHAT TO DO', async () => {
  await assert.rejects(
    () => pdfr.render('http://x', {
      chrome: null, env: { CHROME_PATH: '/definitely/not/here' }, out: tmp(), spawn: fakeChrome(REAL_PDF),
    }),
    (e) => e.missingChrome && /Install Chrome|CHROME_PATH/.test(e.message),
    'the failure does not tell him how to fix it');
  assert.strictEqual(pdfr.findChrome({ CHROME_PATH: '/definitely/not/here' }), null,
    'an explicit CHROME_PATH that does not exist was accepted');
});

check('THE RENDER URL ASKS FOR PRINT MODE', async () => {
  const u = pdfr.reportUrl('http://127.0.0.1:4322', { team: 'ruby', landscape: true });
  assert.match(u, /print=1/, 'the page would render with the nav and buttons in it');
  assert.match(u, /landscape=1/);
  assert.match(u, /team=ruby/, 'it would render whichever team was last selected, not the one being sent');
  assert.match(u, /#reports\/coverage$/, 'the hash route is wrong, so it would render the default page');
});

/* ── the words ────────────────────────────────────────────────────────── */

const REPORT = { teamName: 'Katalon Ruby', coveragePct: 63.27, automated: 120, automatable: 190, ready: 40, blocked: 30, today: '2026-09-29T00:00:00Z', senderName: 'Nghiep Tran' };

check('A TEMPLATE QUOTES LIVE FIGURES', async () => {
  const r = rmail.fill('Hi — {{team}} is at {{coverage}} ({{automated}} of {{automatable}}).', REPORT);
  assert.strictEqual(r.text, 'Hi — Katalon Ruby is at 63.3% (120 of 190).');
  assert.deepStrictEqual(r.used.sort(), ['automatable', 'automated', 'coverage', 'team']);
});

check('AN UNKNOWN PLACEHOLDER IS LEFT AS WRITTEN, not blanked', async () => {
  /* "Coverage is now {{covrage}}" shows a client that something went wrong.
     "Coverage is now " reads as a tool that lost the number — and he would
     never know, because from this end the send returned 250 OK. */
  const r = rmail.fill('Coverage is now {{covrage}}.', REPORT);
  assert.strictEqual(r.text, 'Coverage is now {{covrage}}.');
  assert.deepStrictEqual(r.unknown, ['covrage'], 'the typo was not reported for the preview to show');
});

check('AND A MISSING FIGURE IS A DASH, not the word undefined', async () => {
  const r = rmail.fill('{{coverage}} / {{blocked}}', {});
  assert.strictEqual(r.text, '— / —', 'an empty report produced "undefined" in a client email');
});

check('A TEMPLATE IS CHECKED BEFORE IT IS STORED', async () => {
  const ok = rmail.validate({ name: 'Weekly', subject: 'S', body: 'B', to: 'a@b.com, c@d.com' });
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.deepStrictEqual(ok.template.to, ['a@b.com', 'c@d.com']);

  const bad = rmail.validate({ name: '', subject: '', body: '  ', to: 'nope' });
  assert.ok(!bad.ok);
  assert.strictEqual(bad.errors.length, 4, `expected four complaints, got: ${bad.errors.join(' | ')}`);
  assert.ok(bad.errors.some(e => /email addresses/.test(e)), 'a bad address was accepted');

  /* VALIDATED IN THE MODEL so the SCHEDULER cannot store what the screen
     would have refused — a schedule firing at 8am on a broken address is the
     one failure nobody is watching. */
  assert.ok(!rmail.validate({ name: 'x', subject: 's', body: 'b', to: '' }).ok,
    'a template with no recipients was storable');
});

check('AN UNKNOWN PLACEHOLDER WARNS RATHER THAN REFUSING', async () => {
  /* Very often deliberate — a literal brace in prose. Refusing to save would
     be the tool arguing with him about his own words. */
  const v = rmail.validate({ name: 'x', subject: 'Report {{nope}}', body: 'b', to: 'a@b.com' });
  assert.ok(v.ok, 'a template was refused over a placeholder');
  assert.ok(v.warnings.some(w => /\{\{nope\}\}/.test(w)), 'and nothing warned about it either');
});

check('COMPOSE IS THE ONE PLACE THE WORDS ARE MADE', async () => {
  /* The preview route and the send route both call it, so what he approved
     and what goes out cannot differ. */
  const t = rmail.validate({ name: 'W', subject: '{{team}} coverage', body: 'Now {{coverage}}.', to: 'c@x.com' }).template;
  const m = rmail.compose(t, REPORT, { from: 'n@kms-technology.com', fromName: 'Nghiep Tran' });
  assert.strictEqual(m.subject, 'Katalon Ruby coverage');
  assert.strictEqual(m.text, 'Now 63.3%.');
  assert.strictEqual(m.from, 'Nghiep Tran <n@kms-technology.com>');
  assert.deepStrictEqual(m.to, ['c@x.com']);
});

check('THE ATTACHMENT IS NAMED SO A CLIENT CAN FILE IT', async () => {
  /* The default, for a template that says nothing about it — which is every
     template saved before the file-name box existed. */
  const n = rmail.pdfName(REPORT);
  assert.match(n, /Automation Delivery Dashboard/, 'the default name is not the one on screen');
  assert.match(n, /2026-09-29/, 'it does not say when it was run');
  assert.match(n, /\.pdf$/, 'it would open in nothing');
  assert.ok(!/[\\/:*?"<>|]/.test(n), `a filename cannot carry path characters: ${n}`);
  assert.ok(!/\{\{|\}\}/.test(n), `an unfilled placeholder reached the client: ${n}`);
});

check('AND A TEMPLATE CAN NAME IT ITSELF, with the same placeholders', async () => {
  /* The filename is the one string here that outlives the email — it gets
     saved, attached to a reply, and searched for weeks later — so it takes
     the same tokens as the subject, filled by the same function. Two
     implementations of that would drift, and the drift would be invisible
     until a client asked why the file said a different team. */
  assert.strictEqual(
    rmail.pdfName(REPORT, { filename: 'Coverage {{team}} {{date}}' }),
    'Coverage Katalon Ruby 2026-09-29.pdf');
  assert.strictEqual(
    rmail.pdfName(REPORT, { filename: 'Weekly report.pdf' }), 'Weekly report.pdf',
    'a name that already ends in .pdf grew a second one');
  assert.match(rmail.pdfName(REPORT, { filename: '   ' }), /Automation Delivery Dashboard/,
    'a blank box should mean the default, not an empty name');
  assert.match(rmail.pdfName(REPORT, { filename: '' }), /Automation Delivery Dashboard/);
});

check('{{Date}} WORKS AS WELL AS {{date}}', async () => {
  /* He wrote it capitalised, which is what anyone writing a sentence does.
     Under the old strict lookup it was an UNKNOWN token — and unknown tokens
     are deliberately left as written, so the client would have received a
     file literally called "… - {{Date}}.pdf". Being strict bought nothing:
     there is no second field this could be confused with. */
  assert.strictEqual(rmail.fill('{{Date}}', REPORT).text, rmail.fill('{{date}}', REPORT).text);
  assert.deepStrictEqual(rmail.fill('{{Date}} {{TEAM}} {{Coverage}}', REPORT).unknown, []);
  assert.strictEqual(
    rmail.pdfName(REPORT, { filename: 'Automation Delivery Dashboard - {{Date}}' }),
    'Automation Delivery Dashboard - 2026-09-29.pdf');
  /* Still genuinely unknown ones stay as written, which is the behaviour that
     lets a typo be visible rather than silently blank. */
  assert.deepStrictEqual(rmail.fill('{{covrage}}', REPORT).unknown, ['covrage']);
});

check('A FILENAME CANNOT ESCAPE THE FOLDER IT IS SAVED INTO', async () => {
  /* This string is typed here and becomes a real file on somebody else's
     machine. Separators are the serious one; the Windows-illegal set is the
     one that bites in practice, because his clients are not all on a Mac and
     a colon is exactly what a time wants to contain. */
  const bad = rmail.safeFilename('../../etc/passwd');
  assert.ok(!bad.includes('/') && !bad.includes('\\'), `path separators survived: ${bad}`);
  assert.ok(!bad.startsWith('.'), `it is a hidden file: ${bad}`);

  assert.ok(!/[:*?"<>|]/.test(rmail.safeFilename('Q3: results? <draft> "final" | v2')),
    'a name Windows would refuse');
  assert.ok(!/[\r\n]/.test(rmail.safeFilename('Report\r\nBcc: someone@else.com')),
    'a newline could climb out into a MIME header');
  assert.strictEqual(rmail.safeFilename('.pdf'), 'report.pdf', 'a bare extension is not a filename');
  assert.strictEqual(rmail.safeFilename(''), 'report.pdf');
  assert.strictEqual(rmail.safeFilename(null), 'report.pdf');

  const long = rmail.safeFilename('x'.repeat(500));
  assert.ok(long.length <= rmail.MAX_FILENAME + 4, `${long.length} characters is past what some filesystems take`);
  assert.match(long, /\.pdf$/, 'truncation ate the extension');
});

check('EACH REPORT OFFERS ONLY ITS OWN PLACEHOLDERS', () => {
  /* The tempting way to add the sprint report was one list holding both sets.
     That is the same defect the closed list exists to prevent: a coverage
     template offering `{{committed}}` will eventually have somebody put it in
     a subject line, and it reaches a client as an em-dash. A field that
     cannot mean anything on this report is not offered on this report. */
  const cov = rmail.fieldsFor('coverage').map(f => f.key);
  const spr = rmail.fieldsFor('sprint').map(f => f.key);
  assert.ok(cov.includes('coverage') && !cov.includes('committed'),
    `coverage offers ${cov.join(',')}`);
  assert.ok(spr.includes('committed') && !spr.includes('coverage'),
    `sprint offers ${spr.join(',')}`);
  for (const k of ['team', 'date', 'sender']) {
    assert.ok(cov.includes(k) && spr.includes(k), `${k} should be on every report`);
  }
  /* AND THE OTHER REPORT'S FIELD IS REPORTED AS UNKNOWN rather than silently
     blanked — which is what lets the preview point at it before it is sent. */
  assert.deepStrictEqual(rmail.fill('{{committed}}', {}, 'coverage').unknown, ['committed']);
  assert.deepStrictEqual(rmail.fill('{{coverage}}', {}, 'sprint').unknown, ['coverage']);
});

check('A TEMPLATE WITHOUT A KIND IS A COVERAGE TEMPLATE — the migration', () => {
  /* Every template he has saved so far predates report kinds and has no
     field. They were all coverage templates; anything else here would break
     the one thing that already worked. */
  assert.strictEqual(rmail.reportOf(undefined).key, 'coverage');
  assert.strictEqual(rmail.reportOf('').key, 'coverage');
  assert.strictEqual(rmail.reportOf('nonsense').key, 'coverage');
  assert.strictEqual(rmail.validate({ name: 'x', to: 'a@b.com', subject: 's', body: 'b' }).template.report,
    'coverage', 'a template stored before kinds existed came back without one');
  assert.strictEqual(rmail.reportOf('SPRINT').key, 'sprint', 'the kind is case-sensitive');
});

check('THE SPRINT FIGURES ARE THE SCREEN\'S OWN NUMBERS', () => {
  /* Read off `activeSprintView`, not recomputed — the same rule the coverage
     figures follow, and for the same reason: a mail saying "42 of 60 done"
     over an attachment showing something else is indefensible precisely
     because both numbers look right. */
  const f = rmail.sprintFiguresFrom({
    sprint: { id: 'S41', name: 'PSA Sprint 41' },
    totals: { predicted: 80 },
    progress: {
      committed: 60, done: 42, donePct: 70, remaining: 18, projected: 55,
      blocked: { count: 3, points: 8 },
    },
    window: { timeElapsedPct: 65, elapsed: 6, workingDays: 10 },
    health: { rag: 'amber', score: 62 },
    items: [1, 2, 3, 4, 5],
  }, { teamName: 'Katalon Ruby' });

  assert.strictEqual(rmail.fill('{{done}} of {{committed}}', f, 'sprint').text, '42 of 60');
  assert.strictEqual(rmail.fill('{{donepct}}', f, 'sprint').text, '70%');
  assert.strictEqual(rmail.fill('{{elapsed}}', f, 'sprint').text, '65%');
  assert.strictEqual(rmail.fill('{{blocked}} items, {{blockedpoints}} pts', f, 'sprint').text, '3 items, 8 pts');
  assert.strictEqual(rmail.fill('{{sprint}}', f, 'sprint').text, 'PSA Sprint 41');
  assert.strictEqual(rmail.fill('{{items}}', f, 'sprint').text, '5');
  assert.strictEqual(rmail.fill('{{capacity}}', f, 'sprint').text, '80');
  /* THE RAG WORD, not the score out of 100 — a number invites a question
     about the scale that nobody wants to answer in an email to a client. */
  assert.strictEqual(rmail.fill('{{health}}', f, 'sprint').text, 'amber');
});

check('AND A SPRINT WITH NOTHING IN IT DOES NOT PRODUCE NaN', () => {
  /* Day one of a sprint, or a sprint nobody has estimated. Every one of these
     goes to a client, so an em-dash is the only acceptable empty. */
  const f = rmail.sprintFiguresFrom({}, {});
  const out = rmail.fill('{{committed}} {{done}} {{donepct}} {{projected}} {{health}} {{items}}', f, 'sprint').text;
  assert.ok(!/NaN|undefined|null|\[object/.test(out), `an empty sprint rendered as "${out}"`);
});

check('THE SPRINT ATTACHMENT IS NOT NAMED AFTER THE COVERAGE REPORT', () => {
  const f = rmail.sprintFiguresFrom({ sprint: { name: 'PSA Sprint 41' } }, { today: Date.parse('2026-09-29') });
  const n = rmail.pdfName(f, { report: 'sprint' });
  assert.match(n, /Sprint Report - PSA Sprint 41 - 2026-09-29\.pdf/, `it was called ${n}`);
  assert.ok(!/Automation Delivery Dashboard/.test(n), 'a sprint mail carried the coverage filename');
});

check('EVERY PLACEHOLDER ON EVERY REPORT IS CLOSED AND WORKS', async () => {
  /* These values go to clients. A template reaching into the whole payload is
     how `[object Object]` reaches a client, so the list is a code change.

     LOOPED OVER EVERY REPORT rather than over coverage's list, because the
     point is the property and not the one report that had it first. A third
     report added later is covered without anybody remembering to come back —
     which is the mistake that cost a round trip on the component leak.

     Each is filled against BOTH an empty report and a populated one: empty is
     the day-one sprint and the un-synced store, and it is where a field whose
     `of` forgets its guard renders as NaN in front of a client. */
  for (const [kind, report] of Object.entries(rmail.REPORTS)) {
    assert.ok(report.label, `${kind} has no label`);
    assert.ok(report.route, `${kind} has no page to render`);
    assert.ok(report.defaultFilename, `${kind} has no default filename`);
    const seen = new Set();
    for (const f of report.fields) {
      assert.ok(f.label, `${kind}.${f.key} has no label, so the editor cannot list it`);
      assert.ok(!seen.has(f.key), `${kind} offers ${f.key} twice`);
      seen.add(f.key);
      for (const figures of [REPORT, {}]) {
        const v = rmail.fill(`{{${f.key}}}`, figures, kind);
        assert.deepStrictEqual(v.unknown, [], `${kind}.${f.key} is offered but does not resolve`);
        assert.ok(!/\[object|undefined|NaN/.test(v.text),
          `${kind}.${f.key} rendered as "${v.text}"`);
      }
    }
  }
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
