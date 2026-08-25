#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// Per-model context-window size for the Status gauge; fallback 200k.
function ctxSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('[1m]') !== -1 || m.indexOf('-1m') !== -1) return 1000000;
  if (m.indexOf('claude') !== -1) return 200000;
  if (m.indexOf('gpt-4o') !== -1 || m.indexOf('gpt-4.1') !== -1 || m.indexOf('o1') !== -1 || m.indexOf('o3') !== -1) return 128000;
  if (m.indexOf('qwen') !== -1) return 262144;
  return 200000;
}

// Fire-and-forget emit of a shim-shaped payload to the hive socket. Never throws.
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { c.end(JSON.stringify(payload) + '\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  try { return JSON.parse(s); } catch (e) { return {}; }
}

const MODEL = process.env.HIVE_PROXY_MODEL || '';
const MAX_RETRIES = parseInt(process.env.HIVE_PROXY_MAX_RETRIES || '3', 10);
const BASE_DELAY_MS = parseInt(process.env.HIVE_PROXY_BASE_DELAY_MS || '1000', 10);
const MAX_DELAY_MS = parseInt(process.env.HIVE_PROXY_MAX_DELAY_MS || '30000', 10);
const JITTER_FACTOR = parseFloat(process.env.HIVE_PROXY_JITTER_FACTOR || '0.3');

// Exponential backoff with jitter for 429/5xx errors
function calculateDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const retryAfterSec = parseInt(retryAfterHeader, 10);
    if (!isNaN(retryAfterSec) && retryAfterSec > 0) {
      return retryAfterSec * 1000;
    }
  }
  const expDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = expDelay * JITTER_FACTOR * Math.random();
  return Math.floor(expDelay + jitter);
}

function shouldRetry(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function makeRequestWithRetry(reqOpts, reqBody, attempt) {
  return new Promise((resolve, reject) => {
    const lib = reqOpts.protocol === 'https:' ? https : http;
    const upReq = lib.request(reqOpts, function (upRes) {
      const statusCode = upRes.statusCode || 502;
      const retryAfter = upRes.headers['retry-after'];

      if (shouldRetry(statusCode) && attempt < MAX_RETRIES) {
        const delay = calculateDelay(attempt, retryAfter);
        const isRateLimit = statusCode === 429;
        
        // Emit a warning event to the hive so the orchestrator can track rate limits
        emit({ 
          hook_event_name: 'RateLimitWarning', 
          agent_id: AGENT_ID, 
          session_id: SESSION,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          statusCode,
          delayMs: delay,
          isRateLimit,
          upstream: UPSTREAM,
          model: MODEL
        });

        setTimeout(() => {
          makeRequestWithRetry(reqOpts, reqBody, attempt + 1).then(resolve).catch(reject);
        }, delay);
        return;
      }

      // Success or non-retryable error or max retries exceeded
      const chunks = [];
      let total = 0;
      const ct = String((upRes.headers['content-type'] || ''));
      const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
      const isSse = ct.indexOf('event-stream') !== -1;

      upRes.on('data', function (chunk) {
        res.write(chunk);
        if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
      });

      upRes.on('end', function () {
        res.end();
        if (wantParse && chunks.length) {
          try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
        }
        resolve();
      });

      upRes.on('error', function () { try { res.end(); } catch (e) {} resolve(); });
    });

    upReq.on('error', function () { 
      try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} 
      reject(new Error('upstream connection error'));
    });

    if (reqBody) {
      upReq.write(reqBody);
    }
    upReq.end();
  });
}

// We need access to `res` from the outer handler, so we'll restructure
// The actual handler is below - we'll use a closure

function parseAndEmit(body, isSse) {
  try {
    const events = isSse
      ? body.split('\n\n').filter(Boolean).map(line => {
          if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
          return null;
        }).filter(Boolean)
      : [JSON.parse(body)];

    let model = MODEL;
    let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
    const toolCalls = [];

    for (const o of events) {
      if (!o) continue;
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
      }
      if (o.model) model = o.model;
    }

    if (sawUsage) {
      const pct = ctxSize(model) > 0 ? Math.round(((input + output) / ctxSize(model)) * 100) : 0;
      emit({ hook_event_name: 'Status', agent_id: AGENT_ID, session_id: SESSION, context_pct: pct, model });
    }
    if (toolCalls.length) {
      emit({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tools: toolCalls });
    }
  } catch (e) {}
}

// Main server
const server = http.createServer(function (req, res) {
  cancelStop();

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['transfer-encoding'];

  const upstreamUrl = new URL(trimSlash(UPSTREAM) + req.url);
  const reqOpts = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: req.method,
    headers
  };

  let reqBody = '';
  req.on('data', chunk => { reqBody += chunk; });
  req.on('end', async function () {
    // Attach res to closure for retry function
    const makeRequest = (attempt) => makeRequestWithRetry(reqOpts, reqBody, attempt);
    
    try {
      await makeRequest(0);
    } catch (e) {
      if (!res.writableEnded) {
        try { res.statusCode = 502; res.end('proxy: upstream error after retries'); } catch (e2) {}
      }
    }
  });
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\n'); } catch (e) {}
  process.exit(0);
});

server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\n'); } catch (e) {}
});