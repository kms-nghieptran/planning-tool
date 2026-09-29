'use strict';
const net = require('node:net');
const tls = require('node:tls');

/**
 * smtp.js — enough SMTP to send one message, and nothing else.
 *
 * ── WHY THIS IS HAND-WRITTEN ─────────────────────────────────────────────
 *
 * This tool has no dependencies and runs on his laptop out of a folder. A
 * mail library would be the first one, and the first one is the one that
 * makes "clone it and run it" stop being true. Node already ships `net` and
 * `tls`; SMTP for a single authenticated send is a dozen commands.
 *
 * It is deliberately NOT a general client. No pipelining, no connection
 * reuse, no DSN, no 8BITMIME negotiation — one message, one connection,
 * closed afterwards. Everything below exists because leaving it out produces
 * a failure that looks like success.
 *
 * ── WHAT GOES WRONG WITH SMTP, AND WHY EACH GUARD IS HERE ────────────────
 *
 * IT IS LINE-ORIENTED OVER A STREAM. A reply arrives in as many TCP packets
 * as the network felt like; "250 OK" can land as "25" and "0 OK\r\n". Code
 * that reads one chunk and tests `startsWith('250')` works on every server
 * you try it against and then fails on a slow morning. So replies are
 * buffered and split on CRLF, and a reply is only complete when a line has a
 * SPACE after its code rather than a hyphen — that is how multi-line
 * greetings end, and EHLO's reply is always multi-line.
 *
 * A LONE DOT ENDS THE MESSAGE. A body line that is exactly "." terminates
 * DATA early, so the rest of the mail becomes commands and the server
 * answers each with an error. Dot-stuffing is not an edge case: it is one
 * bullet point in a template away.
 *
 * THE SERVER'S REFUSAL IS THE ONLY USEFUL ERROR. "Send failed" is not
 * actionable; `535 5.7.8 Username and Password not accepted` tells him to go
 * and make an app password. Every rejection carries the code and the text.
 *
 * A HUNG SOCKET IS THE WORST OUTCOME, because the UI just spins. Every wait
 * is bounded, and a timeout says which step it was waiting on.
 */

/** Long enough for a slow relay, short enough that a person does not give up first. */
const TIMEOUT = 20000;

const CRLF = '\r\n';

/**
 * One reply from the server.
 *
 * MULTI-LINE IS THE NORM, not the exception — EHLO answers with one line per
 * extension. The last line is the one with a space after the code; anything
 * with a hyphen is a continuation, and treating the first line as the whole
 * reply loses the extension list that tells us whether STARTTLS exists.
 */
function parseReply(lines) {
  const last = lines[lines.length - 1] || '';
  return {
    code: Number(String(last).slice(0, 3)) || 0,
    /* `lines` WITHOUT the codes, for reading; `text` WITH them, for showing.
       The code is the most useful part of a refusal — "535" is what he can
       look up and what tells him it is the password rather than the address —
       so the string that ends up in the error message keeps it. Stripping it
       here was how `AUTH was refused — Username and Password not accepted`
       lost the one token that identifies the problem. */
    lines: lines.map(l => l.slice(4)),
    text: lines.join(' ').trim(),
    detail: lines.map(l => l.slice(4)).join(' ').trim(),
  };
}

/** A reply is finished when its final line separates code and text with a space. */
const isComplete = (line) => /^\d{3} /.test(line);

class Conn {
  constructor(socket, { debug = null } = {}) {
    this.socket = socket;
    this.buf = '';
    this.lines = [];
    this.waiter = null;
    this.debug = debug;
    this.closed = false;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => {
      this.closed = true;
      this._fail(new Error('The mail server closed the connection.'));
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    /* SPLIT ON CRLF AND KEEP THE REMAINDER. The last element after a split is
       whatever came after the final CRLF — an empty string when the chunk
       ended cleanly, half a line when it did not. Treating it as a line is
       how a reply gets read as two. */
    const parts = this.buf.split(CRLF);
    this.buf = parts.pop();
    for (const line of parts) {
      if (!line) continue;
      if (this.debug) this.debug(`S: ${line}`);
      this.lines.push(line);
      if (isComplete(line) && this.waiter) {
        const { resolve, timer } = this.waiter;
        this.waiter = null;
        clearTimeout(timer);
        const reply = parseReply(this.lines);
        this.lines = [];
        resolve(reply);
      }
    }
  }

  _fail(err) {
    if (!this.waiter) return;
    const { reject, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    reject(err);
  }

  /** Wait for one complete reply, or fail saying what we were waiting for. */
  read(what) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(`The mail server closed the connection before ${what}.`));
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`The mail server did not answer ${what} within ${TIMEOUT / 1000}s.`));
      }, TIMEOUT);
      this.waiter = { resolve, reject, timer };
      return undefined;
    });
  }

  write(line) {
    /* NEVER LOG A LINE THAT MIGHT HOLD A SECRET. AUTH arguments are base64,
       which reads as noise and is not — a debug log with the password in it
       would be the one artefact of this feature nobody thinks to redact. */
    if (this.debug) this.debug(`C: ${/^AUTH|^[A-Za-z0-9+/=]{12,}$/.test(line) ? '[credentials]' : line}`);
    this.socket.write(line + CRLF);
  }

  /** Send a command and read its reply, refusing anything outside `ok`. */
  async cmd(line, ok, what) {
    this.write(line);
    const reply = await this.read(what || line.split(' ')[0]);
    if (!ok.includes(reply.code)) {
      throw Object.assign(new Error(`${what || line.split(' ')[0]} was refused — ${reply.text}`), {
        code: reply.code, smtp: true,
      });
    }
    return reply;
  }

  end() {
    try { this.socket.end(); } catch { /* already gone */ }
  }
}

/**
 * DOT-STUFFING, and the only reason it exists.
 *
 * In DATA, a line consisting of a single "." ends the message. A template
 * with a bulleted line, or a signature separator, can produce exactly that —
 * and the result is not an error: the mail is delivered truncated, and
 * everything after it is fed to the server as commands. Doubling a leading
 * dot is the protocol's own answer; the receiver strips it back off.
 *
 * CRLF EVERYWHERE, too. A bare \n inside DATA is not a line ending to a
 * strict server, and Gmail is strict enough to reject the message.
 */
function stuff(body) {
  return String(body)
    .replace(/\r\n|\r|\n/g, CRLF)
    .split(CRLF)
    .map(l => (l.startsWith('.') ? `.${l}` : l))
    .join(CRLF);
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/**
 * THE PASSWORD AS GOOGLE ACTUALLY HANDS IT OVER.
 *
 * An app password is sixteen characters, and the page that generates it shows
 * them in four groups of four — `abcd efgh ijkl mnop`. Selecting it copies the
 * spaces too, so what lands in the settings field is nineteen characters, and
 * the server answers `535 Username and Password not accepted` — which reads as
 * a wrong password rather than a formatting one. That message has cost people
 * entire evenings.
 *
 * NORMALISED HERE, AT THE POINT OF AUTH, not only on save. A password already
 * stored with its spaces in it then starts working without anybody retyping
 * anything; fixing it only on save would repair the next person to type one
 * and leave the current config broken for no reason the screen can explain.
 *
 * THE SIGNATURE IS DELIBERATELY NARROW. Passwords are allowed to contain
 * spaces, and silently eating them from a real one is a far worse bug than the
 * one this fixes — it cannot authenticate, and it is invisible, because the
 * value is never displayed anywhere. So whitespace is removed ONLY when taking
 * it out leaves exactly sixteen alphanumerics: the shape of a Google or
 * Microsoft app password and very little else. Everything else is passed
 * through with nothing but the outer trim.
 */
const APP_PASSWORD = /^[A-Za-z0-9]{16}$/;
function appPassword(raw) {
  const s = String(raw == null ? '' : raw);
  const squeezed = s.replace(/\s+/g, '');
  if (squeezed !== s && APP_PASSWORD.test(squeezed)) return squeezed;
  return s.trim();
}

/**
 * Send one message.
 *
 * @param {object} cfg  { host, port, secure, user, pass, from }
 * @param {object} msg  { from, to: [], cc: [], subject, raw }  — `raw` is the
 *   complete MIME message from `lib/mime.js`, headers and all. This module
 *   does not build messages; it moves one.
 * @returns {{accepted: string[], response: string}}
 */
async function send(cfg, msg, { debug = null, connect = null } = {}) {
  const host = String((cfg && cfg.host) || '').trim();
  const port = Number((cfg && cfg.port) || 587);
  if (!host) throw new Error('No mail server is configured — set mail.host in config.json.');

  const rcpt = [...(msg.to || []), ...(msg.cc || []), ...(msg.bcc || [])].filter(Boolean);
  if (!rcpt.length) throw new Error('No recipients.');

  /* IMPLICIT TLS ON 465, STARTTLS ON 587. Both are in use and the difference
     is not a preference: connecting in the clear to 465 hangs, and wrapping
     587 in TLS from the first byte is refused. Derived from the port when it
     is not stated, because that is the thing people actually know. */
  const implicit = cfg.secure == null ? port === 465 : !!cfg.secure;

  const open = connect || ((o) => (o.tls
    ? tls.connect({ host: o.host, port: o.port, servername: o.host })
    : net.connect({ host: o.host, port: o.port })));

  const socket = open({ host, port, tls: implicit });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Could not reach ${host}:${port} within ${TIMEOUT / 1000}s.`)), TIMEOUT);
    socket.once(implicit ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(); });
    socket.once('error', (e) => { clearTimeout(t); reject(e); });
  });

  let conn = new Conn(socket, { debug });
  try {
    await conn.read('the greeting');
    const me = 'planning-tool.local';
    let ehlo = await conn.cmd(`EHLO ${me}`, [250], 'EHLO');

    if (!implicit && /STARTTLS/i.test(ehlo.text)) {
      await conn.cmd('STARTTLS', [220], 'STARTTLS');
      /* THE PLAINTEXT SOCKET IS UPGRADED IN PLACE and the connection state
         starts again: everything the server said before the handshake is
         void, which is why EHLO is repeated. Skipping the second EHLO works
         against servers that do not care and fails against those that do. */
      const secure = tls.connect({ socket, servername: host });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('The TLS handshake did not finish.')), TIMEOUT);
        secure.once('secureConnect', () => { clearTimeout(t); resolve(); });
        secure.once('error', (e) => { clearTimeout(t); reject(e); });
      });
      conn = new Conn(secure, { debug });
      ehlo = await conn.cmd(`EHLO ${me}`, [250], 'EHLO after STARTTLS');
    }

    if (cfg.user) {
      /* REFUSED RATHER THAN SENT IN THE CLEAR. Without TLS, AUTH LOGIN puts
         his app password on the wire in base64, which is not encryption. A
         library that quietly did it anyway would be worse than one that
         cannot send at all. */
      const encrypted = implicit || !!conn.socket.encrypted;
      if (!encrypted) {
        throw new Error('The mail server does not offer STARTTLS, so the password would be sent unencrypted. '
          + 'Use port 587 or 465 on a server that supports TLS.');
      }
      const pass = appPassword(cfg.pass);
      if (/AUTH[ -=][^\n]*PLAIN/i.test(ehlo.text)) {
        await conn.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${pass}`)}`, [235], 'the password');
      } else {
        await conn.cmd('AUTH LOGIN', [334], 'AUTH LOGIN');
        await conn.cmd(b64(cfg.user), [334], 'the username');
        await conn.cmd(b64(pass), [235], 'the password');
      }
    }

    const envelopeFrom = msg.from || cfg.from || cfg.user;
    await conn.cmd(`MAIL FROM:<${envelopeFrom}>`, [250], 'the sender');
    const accepted = [];
    for (const who of rcpt) {
      /* ONE RECIPIENT AT A TIME, and a refusal names the address. A loop that
         threw on the first bad one would abandon a send to nine good
         addresses because the tenth had a typo. */
      const r = await conn.cmd(`RCPT TO:<${who}>`, [250, 251], `the recipient ${who}`);
      if (r.code === 250 || r.code === 251) accepted.push(who);
    }
    await conn.cmd('DATA', [354], 'DATA');
    conn.socket.write(`${stuff(msg.raw)}${CRLF}.${CRLF}`);
    const done = await conn.read('the message');
    if (done.code !== 250) {
      throw Object.assign(new Error(`The message was refused — ${done.text}`), { code: done.code, smtp: true });
    }
    try { await conn.cmd('QUIT', [221], 'QUIT'); } catch { /* the message is already accepted */ }
    return { accepted, response: done.text };
  } finally {
    conn.end();
  }
}

module.exports = { send, stuff, parseReply, isComplete, appPassword, TIMEOUT };
