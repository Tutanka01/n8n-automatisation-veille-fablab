// Hôtes de config/veille.json (LLM, flux RSS) dont l'adresse est interne à l'établissement : un proxy
// sortant ne sait pas les joindre, n8n doit y aller en direct. Lancé par entrypoint.sh quand
// OUTBOUND_PROXY est défini ; écrit la liste, séparée par des virgules, sur la sortie standard.
'use strict';
const dns = require('node:dns/promises');
const fs = require('node:fs');
const net = require('node:net');

const CONFIG_FILE = '/home/node/.n8n-files/config/veille.json';

const internal = new net.BlockList();
for (const [prefix, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16]]) internal.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]]) internal.addSubnet(prefix, bits, 'ipv6');

(async () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const hosts = new Set();
  for (const url of [config.llm?.base_url, ...(config.laboratoires || []).map((lab) => lab.flux_rss)]) {
    try { hosts.add(new URL(url).hostname); } catch { /* URL vide ou invalide */ }
  }
  const direct = [];
  for (const host of hosts) {
    try {
      const addresses = await dns.lookup(host, { all: true });
      if (addresses.some((a) => internal.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) direct.push(host);
    } catch { /* nom introuvable d'ici : laissé au proxy */ }
  }
  process.stdout.write(direct.join(','));
})().catch(() => {});
