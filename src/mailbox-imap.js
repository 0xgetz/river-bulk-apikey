'use strict';

/**
 * Inbox backend for a real mailbox reached over IMAP — the counterpart to
 * ./mailtm for providers that block disposable domains.
 *
 * The sign-up gate (measured 2026-10-13) accepts gmail.com and outlook.com and
 * refuses mail.tm, mail.gw, guerrillamail, mailinator and maildrop. Those
 * accepted providers have no free HTTP inbox API, so this backend uses IMAP plus
 * an app password, and gives every account its own `local+tag@domain` alias —
 * one address per account, all landing in the same mailbox.
 *
 * Same shape as MailTM, so provisionAccount() does not care which one it gets:
 *   createAccount() -> {address, password}
 *   waitForCode()   -> the 6-digit code
 */

const { Imap } = require('./imap');

class MailboxImap {
  /**
   * @param {{user: string, password: string, host?: string, port?: number, domain?: string,
   *          proxy?: object|null, log?: Function}} opts
   */
  constructor({ user, password, host = 'imap.gmail.com', port = 993, domain, proxy = null, log } = {}) {
    if (!user || !password) throw new Error('MailboxImap needs IMAP_USER and IMAP_PASS (or --imap-user/--imap-pass)');
    this.user = user;
    this.password = password;
    this.host = host;
    this.port = port;
    this.domain = domain || user.split('@')[1];
    if (!this.domain) throw new Error(`cannot derive a domain from IMAP user ${user}`);
    this.proxy = proxy;
    this.log = log || (() => {});
    this.imap = null;
  }

  /** One fresh alias per account; the mailbox itself is shared. */
  async createAccount({ address } = {}) {
    const local = this.user.split('@')[0].replace(/\+.*$/, '');
    const tag = Math.random().toString(36).slice(2, 8);
    return {
      address: address || `${local}+rb${tag}@${this.domain}`,
      password: '(imap — not used by the mailbox)',
      alias: true,
    };
  }

  /** Polls INBOX for the message addressed to this account's alias. */
  async waitForCode({ address, timeoutMs = 120000, pollMs = 4000 } = {}) {
    if (!address) throw new Error('waitForCode needs the alias to search for');
    if (!this.imap) {
      this.imap = new Imap({
        host: this.host,
        port: this.port,
        user: this.user,
        password: this.password,
        proxy: this.proxy,
        log: this.log,
      });
    }
    return this.imap.waitForCode({ to: address, timeoutMs, pollMs });
  }

  close() {
    if (this.imap) this.imap.close();
  }
}

module.exports = { MailboxImap };
