'use strict';

/**
 * This machine's public address, learned without asking the internet.
 *
 * The egress check exists to drop "proxies" that are really transparent
 * relays handing River this machine's own address — and knowing that address
 * normally means asking an echo service, which is itself a request sent from
 * the very address the proxy list is there to hide.
 *
 * UPnP gives the same answer from inside the LAN: SSDP discovery + a SOAP
 * `GetExternalIPAddress` to the router's WAN connection service. Nothing
 * leaves the local network. When the router has UPnP disabled the caller is
 * told so and decides — this module never falls back to a direct lookup.
 */

const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/** Device/service types an IGD answers to, most specific first. */
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:WANDevice:1',
  'urn:schemas-upnp-org:device:WANConnectionDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'upnp:rootdevice',
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const isIPv4 = (v) => typeof v === 'string' && IPV4.test(v.trim());

/**
 * Addresses that are not the one the internet sees: RFC1918, loopback,
 * link-local, CGNAT (RFC 6598) and the reserved/multicast ranges.
 *
 * CGNAT matters here: an ISP that puts the line behind carrier-grade NAT
 * leaves the router reporting something like 100.64.0.7, and a public site
 * never sees that address. Treating it as "this machine's address" would make
 * the egress check pass every proxy — including a transparent one.
 */
function isPrivateOrCarrierNat(value) {
  const ip = String(value || '').trim();
  if (!isIPv4(ip)) return true;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 carrier-grade NAT
  return false;
}

/** Multicast M-SEARCH; collects the LOCATION of every device that answers. */
function ssdpSearch({ timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = new Map();
    const done = () => {
      try {
        sock.close();
      } catch {}
      resolve([...found.keys()]);
    };
    sock.on('message', (msg) => {
      const loc = /LOCATION:\s*(\S+)/i.exec(msg.toString('utf8'));
      if (loc) found.set(loc[1].trim());
    });
    sock.on('error', () => {});
    sock.bind(() => {
      try {
        sock.setMulticastTTL(2);
      } catch {}
      for (const st of SEARCH_TARGETS) {
        sock.send(
          Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n' +
              `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
              'MAN: "ssdp:discover"\r\n' +
              'MX: 2\r\n' +
              `ST: ${st}\r\n\r\n`
          ),
          SSDP_PORT,
          SSDP_ADDRESS
        );
      }
    });
    setTimeout(done, timeoutMs);
  });
}

function httpGet(url, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** WAN(IP|PPP)Connection control URLs advertised by a device description. */
function wanControlUrls(xml, location) {
  const base = location.slice(0, location.lastIndexOf('/') + 1);
  const out = [];
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const block = m[1];
    const type = /<serviceType>([^<]+)<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>([^<]+)<\/controlURL>/i.exec(block)?.[1];
    if (!type || !control || !/WAN(IP|PPP)Connection/i.test(type)) continue;
    out.push({ type, url: control.startsWith('http') ? control : new URL(control, base).toString() });
  }
  return out;
}

function soapExternalIp({ type, url }, { timeoutMs = 4000 } = {}) {
  const u = new URL(url);
  const body =
    '<?xml version="1.0"?>\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:GetExternalIPAddress xmlns:u="${type}"/></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${type}#GetExternalIPAddress"`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Resolves the router's reported WAN address over the LAN only.
 * Never throws: returns `{ ip: null, error }` when UPnP is unavailable.
 */
async function upnpExternalIp({ timeoutMs = 2500 } = {}) {
  let locations;
  try {
    locations = await ssdpSearch({ timeoutMs });
  } catch (e) {
    return { ip: null, error: `SSDP failed: ${e.message}` };
  }
  if (!locations.length) return { ip: null, error: 'no UPnP device answered on the LAN (UPnP disabled?)' };

  let lastError = 'no WAN connection service advertised';
  for (const location of locations) {
    let xml;
    try {
      xml = await httpGet(location);
    } catch (e) {
      lastError = `${location}: ${e.message}`;
      continue;
    }
    for (const service of wanControlUrls(xml, location)) {
      try {
        const reply = await soapExternalIp(service);
        const ip = /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i.exec(reply)?.[1]?.trim();
        if (isIPv4(ip) && ip !== '0.0.0.0') {
          if (isPrivateOrCarrierNat(ip)) {
            lastError =
              `router reports its WAN address as ${ip}, which is private or carrier-grade NAT — ` +
              'that is not the address the internet sees, so it cannot be compared against a proxy exit';
            continue;
          }
          return { ip, source: `upnp (${service.type.split(':').pop()} via ${new URL(location).host})` };
        }
        lastError = `${service.type}: router reported ${ip || 'nothing'}`;
      } catch (e) {
        lastError = `${service.type}: ${e.message}`;
      }
    }
  }
  return { ip: null, error: lastError };
}

module.exports = { upnpExternalIp, isIPv4, isPrivateOrCarrierNat, ssdpSearch, SEARCH_TARGETS };
