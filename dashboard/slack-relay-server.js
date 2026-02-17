#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SLACK_RELAY_PORT || 8787);
const HOST = process.env.SLACK_RELAY_HOST || '127.0.0.1';
const CONFIG_PATH = process.env.SLACK_RELAY_CONFIG || path.resolve(__dirname, '../slack-relay-config.json');
const DEDUPE_WINDOW_MS = Number(process.env.SLACK_RELAY_DEDUPE_MS || 90_000);

let dedupeMap = new Map();

function pruneDedupe() {
  const now = Date.now();
  for (const [k, ts] of dedupeMap.entries()) {
    if (!Number.isFinite(ts) || now - ts > DEDUPE_WINDOW_MS) dedupeMap.delete(k);
  }
}

function isDuplicate(sig) {
  pruneDedupe();
  const now = Date.now();
  const prev = dedupeMap.get(sig);
  if (prev && now - prev < DEDUPE_WINDOW_MS) return true;
  dedupeMap.set(sig, now);
  return false;
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  if (!cfg.enabled) return { enabled: false };
  if (!cfg.webhookUrl) throw new Error(`Missing webhookUrl in ${CONFIG_PATH}`);
  return cfg;
}

async function postToSlack(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body };
}

function sendJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'slack-relay' });
    return;
  }

  if (req.url !== '/notify' || req.method !== 'POST') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

    const cfg = readConfig();
    if (!cfg.enabled) {
      sendJson(res, 202, { ok: true, skipped: 'disabled' });
      return;
    }

    const text = String(data.text || '').trim();
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'Missing text' });
      return;
    }

    const sig = [
      data?.task?.id || '',
      data?.transition?.from || '',
      data?.transition?.to || '',
      data?.actor || ''
    ].join('|').toLowerCase();

    if (sig && isDuplicate(sig)) {
      sendJson(res, 202, { ok: true, skipped: 'duplicate' });
      return;
    }

    const payload = { text };
    const threadTs = String(data.threadTs || cfg.threadTs || '').trim();
    if (threadTs) payload.thread_ts = threadTs;

    const out = await postToSlack(cfg.webhookUrl, payload);
    if (!out.ok) {
      sendJson(res, 502, { ok: false, error: `Slack webhook HTTP ${out.status}`, response: out.body.slice(0, 200) });
      return;
    }

    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || 'Unknown error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[slack-relay] listening on http://${HOST}:${PORT}`);
  console.log(`[slack-relay] config: ${CONFIG_PATH}`);
});
