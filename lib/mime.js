'use strict';
const crypto = require('node:crypto');

/**
 * mime.js — one email message, built by hand.
 *
 * A report going to a client is the most externally visible thing this tool
 * produces. Everything here is about the message arriving looking the way it
 * left, on a mail client nobody here chose.
 *
 * ── THE FOUR THINGS THAT GO WRONG, AND WHY EACH IS HANDLED ───────────────
 *
 * 1. NON-ASCII IN HEADERS. "Coverage — Katalon Ruby" has an em dash, and his
 *    colleagues' names have Vietnamese diacritics. Raw UTF-8 in a header is
 *    not legal; it arrives as mojibake or gets the message rejected. RFC 2047
 *    encoded-words fix it, and the body's own charset does nothing for this —
 *    headers are a separate problem with a separate answer.
 *
 * 2. LONG LINES. SMTP's limit is 1000 octets including CRLF, and a base64
 *    attachment is one enormous line unless it is wrapped. Over the limit the
 *    server is entitled to reject the message or, worse, fold it itself and
 *    corrupt the PDF.
 *
 * 3. A BOUNDARY THAT OCCURS IN THE CONTENT. If the separator string appears
 *    inside a part, the message splits in the wrong place and the attachment
 *    is destroyed. A random boundary makes that impossible rather than
 *    unlikely.
 *
 * 4. HTML-ONLY BODIES. Some clients, some filters, and anybody reading on a
 *    watch see the plain-text alternative. Sending only HTML means a blank
 *    mail for them, so both go, as multipart/alternative.
 */

/** RFC 5322 is 998; 76 keeps base64 well clear and is what every client uses. */
const WRAP = 76;

/**
 * A HEADER VALUE, ENCODED ONLY IF IT NEEDS TO BE.
 *
 * Plain ASCII is left alone — an encoded-word around "Weekly coverage" is
 * legal, ugly in any client that shows raw headers, and pointless. Anything
 * else becomes one or more base64 encoded-words.
 *
 * SPLIT ON WHOLE CHARACTERS. An encoded-word has a 75-character limit, and
 * slicing a JavaScript string mid-surrogate or mid-multibyte produces a
 * replacement character in the recipient's subject line. Chunked by decoded
 * characters with the byte length checked, so a name never breaks apart.
 */
function encodeHeader(value) {
  const s = String(value == null ? '' : value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(s)) return s;
  const words = [];
  let cur = '';
  for (const ch of s) {
    const next = cur + ch;
    if (Buffer.byteLength(next, 'utf8') > 36) { words.push(cur); cur = ch; } else { cur = next; }
  }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/**
 * ONE ADDRESS, DISPLAY NAME AND ALL.
 *
 * The name is encoded and quoted; the address is not touched beyond trimming.
 * A CR or LF anywhere in either is removed rather than escaped — that is
 * header injection, and the only safe answer for a field this tool builds
 * from a text box is that a newline cannot survive into a header at all.
 */
function address(input) {
  const raw = String(input == null ? '' : input).replace(/[\r\n]+/g, ' ').trim();
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m && m[2]) {
    const name = m[1].replace(/["\\]/g, '').trim();
    if (!name) return m[2].trim();
    const enc = encodeHeader(name);
    /* QUOTED WHEN IT HOLDS A SPECIAL, and an encoded-word never is — quoting
       one stops it being decoded, so the client shows the raw `=?UTF-8?B?…`.
       This matters beyond tidiness: a colon or a comma loose in an unquoted
       display name is not legal, and parsers disagree about where the address
       then starts. Since a newline in this field has already been flattened
       to a space, the leftovers of an injection attempt end up visibly inside
       the quotes rather than anywhere they could be read as a header. */
    const needsQuote = !enc.startsWith('=?') && /[()<>@,;:\\".[\]]/.test(enc);
    return `${needsQuote ? `"${enc}"` : enc} <${m[2].trim()}>`;
  }
  return raw;
}

/** Just the address part, which is what SMTP's envelope wants. */
function bare(input) {
  const raw = String(input == null ? '' : input).replace(/[\r\n]+/g, ' ').trim();
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

/* Deliberately permissive. This is a sanity check against a typo, not an
   attempt to decide what RFC 5321 allows — an over-strict pattern that
   refuses a real address the client uses is worse than a loose one. */
const LOOKS_LIKE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const isEmail = (v) => LOOKS_LIKE_EMAIL.test(bare(v));

/** Split a typed list on commas, semicolons or newlines; drop the empties. */
const parseList = (text) => String(text == null ? '' : text)
  .split(/[,;\n\r]+/).map(s => s.trim()).filter(Boolean);

const wrap = (b64) => (b64.match(new RegExp(`.{1,${WRAP}}`, 'g')) || []).join('\r\n');

/** A boundary that cannot occur in the content, because nothing generates it. */
const boundary = () => `=_pt_${crypto.randomBytes(16).toString('hex')}`;

/** Escape for the HTML body — a summary can hold a component name with an &. */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Turn the template's plain-text body into a readable HTML one.
 *
 * NOT A MARKDOWN RENDERER. He writes prose in a textarea; this preserves the
 * paragraphs he typed and escapes the rest. Anything cleverer would be a
 * second thing to be surprised by on the client's screen.
 */
function textToHtml(text) {
  const paras = String(text == null ? '' : text).replace(/\r\n/g, '\n').split(/\n{2,}/);
  return paras
    .map(p => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * Build the complete message.
 *
 * @param {object} o
 *   from, to[], cc[], subject, text, html?, attachments[{filename, content:Buffer, contentType}]
 * @returns {{raw: string, to: string[], cc: string[], messageId: string}}
 */
function build(o = {}) {
  const to = (o.to || []).map(bare).filter(Boolean);
  const cc = (o.cc || []).map(bare).filter(Boolean);
  if (!to.length) throw new Error('An email needs at least one recipient.');

  const bad = [...(o.to || []), ...(o.cc || [])].filter(v => String(v).trim() && !isEmail(v));
  if (bad.length) throw new Error(`These do not look like email addresses: ${bad.map(bare).join(', ')}`);

  const alt = boundary();
  const mixed = boundary();
  const atts = (o.attachments || []).filter(a => a && a.content && a.content.length);
  const host = (bare(o.from).split('@')[1] || 'planning-tool.local');
  const messageId = `<${crypto.randomBytes(12).toString('hex')}.${Date.now().toString(36)}@${host}>`;

  const text = String(o.text == null ? '' : o.text);
  const html = o.html || `<!doctype html><html><body style="font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a">
${textToHtml(text)}
</body></html>`;

  const head = [
    `From: ${address(o.from)}`,
    `To: ${to.map(address).join(', ')}`,
    cc.length ? `Cc: ${cc.map(address).join(', ')}` : null,
    `Subject: ${encodeHeader(o.subject || '')}`,
    `Date: ${new Date(o.date || Date.now()).toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    /* SAYING WHAT MADE IT. A client asking "what sent this?" about a report
       with his name on it should get an answer from the headers rather than
       from him. */
    'X-Mailer: Planning Tool',
  ].filter(Boolean);

  const body = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(text, 'utf8').toString('base64')),
    '',
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(html, 'utf8').toString('base64')),
    '',
    `--${alt}--`,
  ].join('\r\n');

  /* NO multipart/mixed WRAPPER WHEN THERE IS NOTHING TO ATTACH. A mixed part
     of one is legal and some clients draw a paperclip for it, which on a mail
     with no attachment is a small lie the reader has to go and check. */
  if (!atts.length) {
    return { raw: [...head, body].join('\r\n'), to, cc, messageId };
  }

  const parts = [
    ...head,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    body,
    '',
  ];
  for (const a of atts) {
    const name = String(a.filename || 'attachment.pdf').replace(/[\r\n"]+/g, '');
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      /* `attachment`, NOT `inline`. A PDF marked inline is rendered in the
         reading pane by some clients and never appears as a file — and "the
         attachment is missing" is what the client will say. */
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      wrap(Buffer.from(a.content).toString('base64')),
      '',
    );
  }
  parts.push(`--${mixed}--`);
  return { raw: parts.join('\r\n'), to, cc, messageId };
}

module.exports = { build, address, bare, isEmail, parseList, encodeHeader, textToHtml, WRAP };
