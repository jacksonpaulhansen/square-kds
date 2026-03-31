import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const host = '127.0.0.1';
const port = 8787;
const projectRoot = process.cwd();
const apiVersion = '2026-03-22-publish-app-1';

let publishRunning = false;
let publishStartedAt = 0;
let ehpkRunning = false;
let lastPublish = {
  ok: null,
  error: '',
  logs: '',
  at: '',
};

// Square KDS state
let squareOrderCache = [];
let squareCacheAt = 0;
let squareFetchRunning = false;
let squarePollInterval = null;
const SQUARE_POLL_MS = 15000;
// IDs optimistically suppressed pending Square confirmation (cleared after 30s)
const pendingSuppressIds = new Map(); // id → timestamp

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readConfig() {
  const configPath = path.join(projectRoot, 'app.config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function writeConfig(config) {
  const configPath = path.join(projectRoot, 'app.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function readLocalSecrets() {
  const secretsPath = path.join(projectRoot, '.app.secrets.local.json');
  if (!fs.existsSync(secretsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeLocalSecrets(secrets) {
  const secretsPath = path.join(projectRoot, '.app.secrets.local.json');
  fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8');
}

// --- Square KDS helpers ---

function readSquareSecrets() {
  const secrets = readLocalSecrets();
  return {
    accessToken: String(secrets.squareAccessToken || '').trim(),
    locationId: String(secrets.squareLocationId || '').trim(),
    environment: String(secrets.squareEnvironment || 'sandbox').trim(),
  };
}

function squareApiBase(environment) {
  return environment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

function truncateStr(str, maxLen) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '\u2026';
}

function normalizeOrder(o) {
  // displayId: ticket_name (Square for Restaurants) or last 4 of order ID
  const ticketName = String(o.ticket_name || '').trim();
  const displayId = ticketName
    ? truncateStr(ticketName, 8)
    : String(o.id || '').slice(-4).toUpperCase();

  // customerName: fulfillment recipient → ticket name → fallback
  const recipient = o.fulfillments?.[0]?.pickup_details?.recipient?.display_name;
  const customerName = String(recipient || ticketName || 'Order').trim() || 'Order';

  // itemLines: flat array of pre-formatted display strings
  const itemLines = [];
  for (const item of o.line_items || []) {
    const qty = parseInt(item.quantity || '1', 10);
    const name = String(item.name || 'Item').trim();
    itemLines.push(`${qty}x ${name}`);
    for (const mod of item.modifiers || []) {
      const modName = String(mod.name || '').trim();
      if (modName) itemLines.push(`   +${modName}`);
    }
    const itemNote = String(item.note || '').trim();
    if (itemNote) itemLines.push(`   *${itemNote}`);
  }

  // noteLines: order-level notes (no truncation — let the display wrap)
  const noteLines = [];
  const pickupNote = String(o.fulfillments?.[0]?.pickup_details?.note || '').trim();
  const metaNote = String(o.metadata?.note || '').trim();
  const orderNote = pickupNote || metaNote;
  if (orderNote) noteLines.push(`NOTE: ${orderNote}`);

  return {
    id: String(o.id || ''),
    displayId,
    customerName: truncateStr(customerName, 16),
    itemLines,
    noteLines,
    createdAt: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
    state: String(o.state || 'OPEN'),
    fulfillmentState: String(o.fulfillments?.[0]?.state || 'PROPOSED'),
    version: Number(o.version || 0),
  };
}

async function fetchSquareOrders() {
  if (squareFetchRunning) return;
  const { accessToken, locationId, environment } = readSquareSecrets();
  if (!accessToken || !locationId) return;

  squareFetchRunning = true;
  try {
    const base = squareApiBase(environment);
    const orders = [];
    let cursor = undefined;

    do {
      const body = {
        location_ids: [locationId],
        query: {
          filter: { state_filter: { states: ['OPEN'] } },
          sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
        },
        limit: 50,
      };
      if (cursor) body.cursor = cursor;

      const resp = await fetch(`${base}/v2/orders/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-11-20',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.error('[square] fetchSquareOrders failed:', resp.status, await resp.text());
        break;
      }

      const data = await resp.json();
      for (const o of data.orders || []) {
        // Skip orders where every fulfillment is already COMPLETED or CANCELED
        const fulfillments = o.fulfillments ?? [];
        const allDone = fulfillments.length > 0 && fulfillments.every(
          f => f.state === 'COMPLETED' || f.state === 'CANCELED' || f.state === 'FAILED'
        );
        if (!allDone) orders.push(normalizeOrder(o));
      }
      cursor = data.cursor || null;
    } while (cursor);

    // Prune stale suppressions (older than 30s)
    const now = Date.now();
    for (const [id, ts] of pendingSuppressIds) {
      if (now - ts > 30000) pendingSuppressIds.delete(id);
    }
    // Filter out any IDs we're suppressing (recently cancelled/completed)
    squareOrderCache = orders.filter(o => !pendingSuppressIds.has(o.id));
    squareCacheAt = Date.now();
  } catch (err) {
    console.error('[square] fetchSquareOrders error:', err);
  } finally {
    squareFetchRunning = false;
  }
}

async function markOrderComplete(orderId) {
  const { accessToken, locationId, environment } = readSquareSecrets();
  if (!accessToken || !locationId) return { ok: false, error: 'Not configured' };

  const base = squareApiBase(environment);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-11-20',
  };

  try {
    // Always fetch the live version — cached version may be stale and Square requires exact match
    const getResp = await fetch(`${base}/v2/orders/${orderId}`, { method: 'GET', headers });
    const getData = await getResp.json().catch(() => null);
    if (!getResp.ok) {
      console.error('[square] markOrderComplete GET failed:', getResp.status, JSON.stringify(getData));
      return { ok: false, error: `Could not fetch order: ${getData?.errors?.[0]?.detail || getResp.status}` };
    }
    const liveVersion = Number(getData?.order?.version ?? 0);
    console.log('[square] markOrderComplete fetched version:', liveVersion, 'for order:', orderId);

    // Get the fulfillment UID — we update fulfillment state, not order state.
    // Fulfillment COMPLETED = food handed off. Order state is set by Square when payment clears.
    const fulfillments = getData?.order?.fulfillments ?? [];
    const fulfillmentUid = fulfillments[0]?.uid ?? null;

    const orderUpdate = fulfillmentUid
      ? {
          location_id: locationId,
          version: liveVersion,
          fulfillments: [{ uid: fulfillmentUid, state: 'COMPLETED' }],
        }
      : {
          // No fulfillment on this order (e.g. sandbox order created via API without one)
          // Fall back to marking order state directly
          location_id: locationId,
          version: liveVersion,
          state: 'COMPLETED',
        };

    const putResp = await fetch(`${base}/v2/orders/${orderId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: orderUpdate,
      }),
    });

    const putData = await putResp.json().catch(() => null);
    if (!putResp.ok) {
      const errDetail = putData?.errors?.[0]?.detail || putData?.errors?.[0]?.code || putResp.status;
      console.error('[square] markOrderComplete PUT failed:', putResp.status, JSON.stringify(putData));
      return { ok: false, error: String(errDetail) };
    }
    console.log('[square] markOrderComplete ok:', orderId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function markOrderPrepared(orderId) {
  const { accessToken, locationId, environment } = readSquareSecrets();
  if (!accessToken || !locationId) return { ok: false, error: 'Not configured' };

  const base = squareApiBase(environment);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-11-20',
  };

  try {
    const getResp = await fetch(`${base}/v2/orders/${orderId}`, { method: 'GET', headers });
    const getData = await getResp.json().catch(() => null);
    if (!getResp.ok) return { ok: false, error: `Could not fetch order: ${getData?.errors?.[0]?.detail || getResp.status}` };

    const liveVersion = Number(getData?.order?.version ?? 0);
    const fulfillmentUid = getData?.order?.fulfillments?.[0]?.uid ?? null;
    if (!fulfillmentUid) return { ok: false, error: 'No fulfillment on order' };

    const putResp = await fetch(`${base}/v2/orders/${orderId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: { location_id: locationId, version: liveVersion, fulfillments: [{ uid: fulfillmentUid, state: 'PREPARED' }] },
      }),
    });
    const putData = await putResp.json().catch(() => null);
    if (!putResp.ok) {
      const errDetail = putData?.errors?.[0]?.detail || putData?.errors?.[0]?.code || putResp.status;
      return { ok: false, error: String(errDetail) };
    }
    console.log('[square] markOrderPrepared ok:', orderId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const TEST_NAMES = [
  'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Elijah', 'Sophia', 'James',
  'Isabella', 'Oliver', 'Mia', 'William', 'Charlotte', 'Benjamin', 'Amelia',
  'Lucas', 'Harper', 'Henry', 'Evelyn', 'Alexander', 'Luna', 'Mason',
  'Camila', 'Ethan', 'Penelope', 'Daniel', 'Riley', 'Jacob', 'Nora', 'Logan',
];
let lastTestNameIndex = -1;

function pickTestName() {
  let idx;
  do { idx = Math.floor(Math.random() * TEST_NAMES.length); } while (idx === lastTestNameIndex);
  lastTestNameIndex = idx;
  return TEST_NAMES[idx];
}

async function createTestOrder() {
  const { accessToken, locationId, environment } = readSquareSecrets();
  if (!accessToken || !locationId) return { ok: false, error: 'Square not configured' };

  const base = squareApiBase(environment);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-11-20',
  };

  // Fetch catalog items
  const catalogResp = await fetch(`${base}/v2/catalog/list?types=ITEM`, { headers });
  const catalogData = await catalogResp.json().catch(() => null);
  const catalogItems = (catalogData?.objects ?? []).filter(o => o.type === 'ITEM' && o.item_data?.variations?.length);

  let lineItems;

  if (catalogItems.length === 0) {
    // No catalog — use hardcoded donut items
    lineItems = [
      {
        name: 'Mini Donuts',
        quantity: String(Math.floor(Math.random() * 2) + 1),
        base_price_money: { amount: 600, currency: 'USD' },
        note: ['glazed', 'cinnamon sugar', 'powdered sugar', 'chocolate'][Math.floor(Math.random() * 4)],
      },
    ];
  } else {
    // Pick 1-3 random catalog items and build line items from their variations
    const shuffled = catalogItems.sort(() => Math.random() - 0.5).slice(0, Math.floor(Math.random() * 3) + 1);
    lineItems = shuffled.map(item => {
      const variations = item.item_data.variations;
      const variation = variations[Math.floor(Math.random() * variations.length)];
      const price = variation.item_variation_data?.price_money?.amount ?? 500;
      const qty = Math.floor(Math.random() * 2) + 1;

      const entry = {
        catalog_object_id: variation.id,
        quantity: String(qty),
        base_price_money: { amount: price, currency: 'USD' },
      };

      // Optionally add a modifier if the item has modifier lists
      const modifierListIds = item.item_data?.modifier_list_info?.map(m => m.modifier_list_id) ?? [];
      if (modifierListIds.length > 0) {
        // We'll add a note instead since fetching modifier objects requires another call
        entry.note = 'extra toppings please';
      }
      return entry;
    });
  }

  const totalAmount = lineItems.reduce((sum, li) => {
    const price = li.base_price_money?.amount ?? 0;
    return sum + price * Number(li.quantity ?? 1);
  }, 0);

  const customerName = pickTestName();

  // Create order with a PICKUP fulfillment so it shows up in KDS properly
  const orderResp = await fetch(`${base}/v2/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: locationId,
        ticket_name: customerName,
        line_items: lineItems,
        fulfillments: [{
          type: 'PICKUP',
          state: 'PROPOSED',
          pickup_details: {
            recipient: { display_name: customerName },
            schedule_type: 'ASAP',
            note: Math.random() > 0.6 ? 'nut allergy' : undefined,
          },
        }],
      },
    }),
  });

  const orderData = await orderResp.json().catch(() => null);
  if (!orderResp.ok) {
    console.error('[square] createTestOrder order failed:', JSON.stringify(orderData));
    return { ok: false, error: orderData?.errors?.[0]?.detail ?? String(orderResp.status) };
  }

  const orderId = orderData.order.id;
  const orderVersion = orderData.order.version;
  console.log('[square] createTestOrder created order:', orderId, 'for', customerName);

  // Pay with cash so the order has a payment and can be completed
  const payResp = await fetch(`${base}/v2/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      source_id: 'CASH',
      amount_money: { amount: totalAmount, currency: 'USD' },
      cash_details: {
        buyer_supplied_money: { amount: totalAmount, currency: 'USD' },
      },
      order_id: orderId,
      location_id: locationId,
    }),
  });

  const payData = await payResp.json().catch(() => null);
  if (!payResp.ok) {
    console.error('[square] createTestOrder payment failed:', JSON.stringify(payData));
    return { ok: false, error: `Order created but payment failed: ${payData?.errors?.[0]?.detail ?? payResp.status}` };
  }

  console.log('[square] createTestOrder payment ok for order:', orderId);

  // Refresh cache so the new order appears immediately
  void fetchSquareOrders();

  return { ok: true, orderId, customerName, totalAmount, lineItemCount: lineItems.length };
}

function startSquarePoll() {
  if (squarePollInterval) clearInterval(squarePollInterval);
  squarePollInterval = setInterval(() => { void fetchSquareOrders(); }, SQUARE_POLL_MS);
  void fetchSquareOrders();
}

// --- end Square KDS helpers ---

function runGit(args) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    git.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    git.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    git.on('error', reject);
    git.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `git ${args.join(' ')} failed with code ${code}`));
      }
    });
  });
}

function runGitWithPat(args, owner, repo, token) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GITHUB_TOKEN: token };
    const askpassPath = path.join(projectRoot, 'scripts', 'git-askpass.cmd');
    env.GIT_ASKPASS = askpassPath;

    const git = spawn('git', args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let output = '';
    git.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    git.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    git.on('error', reject);
    git.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `git ${args.join(' ')} failed with code ${code}`));
      }
    });
  });
}

async function githubApi({ token, method, pathName, body }) {
  const response = await fetch(`https://api.github.com${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function sanitizeRepoName(name) {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return clean || 'even-g2-app';
}

function runPublishLegacy() {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectRoot, 'publish-qr.ps1');
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-NonInteractive'],
      {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    ps.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    ps.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    const timer = setTimeout(() => {
      ps.kill('SIGTERM');
      reject(new Error('Publish timed out after 120s'));
    }, 120000);

    ps.on('error', reject);
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `publish-qr.ps1 exited with code ${code}`));
      }
    });
  });
}

function triggerReboot() {
  const scriptPath = path.join(projectRoot, 'reboot-app.ps1');
  const ps = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      cwd: projectRoot,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    },
  );
  ps.unref();
}

function triggerSwitchGitAccount() {
  const scriptPath = path.join(projectRoot, 'switch-git-account.ps1');
  const child = spawn(
    'cmd',
    ['/c', 'start', '""', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', scriptPath],
    {
      cwd: projectRoot,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();
}

function openUrl(url) {
  const child = spawn('cmd', ['/c', 'start', '""', url], {
    cwd: projectRoot,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function openPath(targetPath) {
  const child = spawn('cmd', ['/c', 'start', '""', targetPath], {
    cwd: projectRoot,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function runCommand(command, args, options = {}) {
  const spawnOnce = (cmd, cmdArgs, extra = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, cmdArgs, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
        ...extra,
      });

      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      child.on('error', (err) => {
        err.output = output;
        reject(err);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(output || `${cmd} ${cmdArgs.join(' ')} failed with code ${code}`));
        }
      });
    });

  return (async () => {
    try {
      return await spawnOnce(command, args);
    } catch (error) {
      if (process.platform === 'win32' && String(error?.code || '') === 'EINVAL') {
        // Windows fallback for sporadic spawn EINVAL from .cmd invocations.
        return await spawnOnce('cmd.exe', ['/d', '/s', '/c', command, ...args]);
      }
      throw error;
    }
  })();
}

async function runEhpkBuild(appNameRaw) {
  const logs = [];
  const appName = String(appNameRaw || '').trim() || 'even-g2-app';
  const ehpkName = appName.slice(0, 20);
  const safeName = sanitizeRepoName(appName);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const appJsonPath = path.join(projectRoot, 'app.json');
  const distPath = path.join(projectRoot, 'dist');
  const outputDir = path.join(projectRoot, 'ehpk');
  const outputFile = `${safeName}.ehpk`;
  const outputPath = path.join(outputDir, outputFile);

  logs.push('Building web app (dist)...');
  await runCommand(npmCmd, ['run', 'build']);

  if (!fs.existsSync(appJsonPath)) {
    logs.push('app.json not found. Creating with evenhub init...');
    await runCommand(npxCmd, ['@evenrealities/evenhub-cli', 'init', '--output', 'app.json']);
  }

  if (!fs.existsSync(distPath)) {
    throw new Error('dist folder missing after build. Cannot pack .ehpk.');
  }

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  if (appName !== ehpkName) {
    logs.push(`App name trimmed for EHPK (max 20 chars): "${appName}" -> "${ehpkName}"`);
  }
  appJson.name = ehpkName;
  appJson.entrypoint = 'index.html';
  appJson.version = String(appJson.version || '0.1.0');
  if (!appJson.package_id || String(appJson.package_id).includes('example')) {
    appJson.package_id = `com.${safeName.replace(/[^a-z0-9.]/g, '') || 'eveng2app'}`;
  }
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`, 'utf8');

  fs.mkdirSync(outputDir, { recursive: true });

  logs.push(`Packing .ehpk (${outputFile})...`);
  const packOutput = await runCommand(npxCmd, [
    '@evenrealities/evenhub-cli',
    'pack',
    'app.json',
    'dist',
    '--output',
    outputPath,
  ]);

  if (/invalid app\.json/i.test(String(packOutput))) {
    throw new Error(`EHPK pack failed: ${String(packOutput).trim()}`);
  }

  let finalOutputPath = outputPath;
  if (!fs.existsSync(finalOutputPath)) {
    const candidates = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.ehpk'))
      .map((d) => path.join(outputDir, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length > 0) {
      finalOutputPath = candidates[0];
    } else {
      throw new Error(
        `EHPK pack reported success but no output file was created. CLI output:\n${String(packOutput).trim()}`,
      );
    }
  }

  logs.push(`Created package: ${finalOutputPath}`);
  openPath(outputDir);

  return {
    logs: logs.join('\n'),
    outputPath: finalOutputPath,
    outputFile,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPublishedUrl(url, timeoutMs = 90000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probeUrl = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      const response = await fetch(probeUrl, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
      });
      if (response.ok) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function generateQrForUrl(publishUrl) {
  await new Promise((resolve, reject) => {
    const node = spawn('node', ['scripts/generate-qr.mjs', publishUrl], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    node.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    node.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    node.on('error', reject);
    node.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `QR generation failed with code ${code}`));
      }
    });
  });

  const htmlPath = path.join(projectRoot, 'publish-qr.html');
  if (fs.existsSync(htmlPath)) {
    openUrl(htmlPath);
  }
}

async function runPublishApp(appName, patInput) {
  const logs = [];
  const config = readConfig();
  const secrets = readLocalSecrets();

  config.github = config.github || {};
  const token = (patInput || secrets.githubPat || '').trim();
  if (!token) {
    const err = new Error('PAT_REQUIRED');
    err.code = 'PAT_REQUIRED';
    throw err;
  }

  const userResult = await githubApi({ token, method: 'GET', pathName: '/user' });
  if (!userResult.response.ok) {
    const err = new Error('Invalid GitHub PAT. Please provide a valid token with repo/workflow/pages permissions.');
    err.code = 'INVALID_PAT';
    throw err;
  }

  const owner = String(userResult.json?.login || '').trim();
  if (!owner) {
    throw new Error('Failed to resolve GitHub user from PAT.');
  }

  const repo = sanitizeRepoName(appName);
  const remoteUrl = `https://github.com/${owner}/${repo}.git`;
  const publishUrl = `https://${owner}.github.io/${repo}/`;

  // Create repo if needed.
  const createRepoResult = await githubApi({
    token,
    method: 'POST',
    pathName: '/user/repos',
    body: {
      name: repo,
      private: true,
      auto_init: false,
    },
  });

  const repoCreated = createRepoResult.response.status === 201;
  if (repoCreated) {
    logs.push(`Created repo: ${owner}/${repo}`);
  } else if (createRepoResult.response.status === 422) {
    logs.push(`Repo already exists: ${owner}/${repo}`);
  } else if (!createRepoResult.response.ok) {
    throw new Error(`GitHub repo create failed: ${createRepoResult.text || createRepoResult.response.status}`);
  }

  const branch = 'main';
  const userName = owner;
  const ghId = String(userResult.json?.id ?? '').trim();
  const userEmail = ghId
    ? `${ghId}+${owner}@users.noreply.github.com`
    : `${owner}@users.noreply.github.com`;

  config.appName = appName;
  config.publishUrl = publishUrl;
  config.github.owner = owner;
  config.github.repo = repo;
  config.github.pat = '';
  config.git = config.git || {};
  config.git.enabled = true;
  config.git.userName = userName;
  config.git.userEmail = userEmail;
  config.git.remoteUrl = remoteUrl;
  config.git.branch = branch;
  config.git.commitMessagePrefix = config.git.commitMessagePrefix || 'publish';
  config.git.autoSetGithubPagesUrl = true;
  config.git.users = Array.isArray(config.git.users) ? config.git.users : [];
  config.git.repos = Array.isArray(config.git.repos) ? config.git.repos : [];
  config.git.deployed = false;

  if (!config.git.users.some((u) => u?.name === userName && u?.email === userEmail)) {
    config.git.users.push({ name: userName, email: userEmail });
  }
  if (!config.git.repos.includes(remoteUrl)) {
    config.git.repos.push(remoteUrl);
  }

  writeConfig(config);
  if (patInput && patInput.trim()) {
    secrets.githubPat = token;
    writeLocalSecrets(secrets);
  }

  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    await runGit(['init', '-b', branch]);
  }

  await runGit(['config', 'user.name', userName]);
  await runGit(['config', 'user.email', userEmail]);
  await runGit(['config', 'credential.helper', 'manager']);

  try {
    await runGit(['remote', 'add', 'origin', remoteUrl]);
  } catch {
    await runGit(['remote', 'set-url', 'origin', remoteUrl]);
  }

  await runGit(['add', '-A']);
  const diffOutput = await runGit(['diff', '--cached', '--name-only']);
  const hasChanges = diffOutput.trim().length > 0;
  if (hasChanges) {
    await runGit([
      '-c',
      `user.name=${userName}`,
      '-c',
      `user.email=${userEmail}`,
      'commit',
      '-m',
      `publish ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    ]);
    logs.push('Committed local changes');
  } else {
    logs.push('No new file changes to commit');
  }

  await runGitWithPat(['push', '-u', remoteUrl, `HEAD:${branch}`], owner, repo, token);
  logs.push(`Pushed to origin/${branch}`);

  async function setRepoVisibility(isPrivate) {
    const patchRes = await githubApi({
      token,
      method: 'PATCH',
      pathName: `/repos/${owner}/${repo}`,
      body: { private: isPrivate },
    });
    return patchRes.response.ok;
  }

  async function enablePagesOnce() {
    const putRes = await githubApi({
      token,
      method: 'PUT',
      pathName: `/repos/${owner}/${repo}/pages`,
      body: { build_type: 'workflow' },
    });
    if (putRes.response.ok) {
      return { ok: true, via: 'PUT', status: putRes.response.status, text: putRes.text };
    }

    const postRes = await githubApi({
      token,
      method: 'POST',
      pathName: `/repos/${owner}/${repo}/pages`,
      body: { build_type: 'workflow' },
    });
    if (postRes.response.ok || postRes.response.status === 409) {
      return { ok: true, via: 'POST', status: postRes.response.status, text: postRes.text };
    }

    return {
      ok: false,
      via: 'POST',
      status: postRes.response.status,
      text: postRes.text || putRes.text,
      putStatus: putRes.response.status,
      putText: putRes.text,
    };
  }

  async function pagesIsActive() {
    const pagesGet = await githubApi({
      token,
      method: 'GET',
      pathName: `/repos/${owner}/${repo}/pages`,
    });
    return pagesGet.response.ok;
  }

  // GitHub Pages deploy is most reliable for public repos in this workflow.
  // Keep publish fully automated by switching to public before enabling Pages.
  const madePublic = await setRepoVisibility(false);
  if (!madePublic) {
    logs.push('Warning: could not force repo public before enabling Pages. Continuing...');
  } else {
    logs.push('Repo visibility set to public for Pages deployment.');
  }

  // Enable Pages with workflow build type and verify activation (with retries).
  let enabled = false;
  let lastEnableErr = '';
  for (let i = 0; i < 5; i += 1) {
    const pagesEnable = await enablePagesOnce();
    if (!pagesEnable.ok) {
      lastEnableErr = String(pagesEnable.text || pagesEnable.status || 'unknown');
      await sleep(2000);
      continue;
    }

    if (await pagesIsActive()) {
      enabled = true;
      break;
    }
    await sleep(3000);
  }

  if (!enabled) {
    throw new Error(`Unable to enable GitHub Pages automatically: ${lastEnableErr || 'not active after retries'}`);
  }
  logs.push('GitHub Pages enabled and active');

  // Trigger deploy workflow
  const workflowDispatch = await githubApi({
    token,
    method: 'POST',
    pathName: `/repos/${owner}/${repo}/actions/workflows/deploy-pages.yml/dispatches`,
    body: { ref: branch },
  });

  if (workflowDispatch.response.status === 204) {
    logs.push('Triggered Deploy GitHub Pages workflow');
  } else {
    logs.push(`Workflow dispatch warning: ${workflowDispatch.text || workflowDispatch.response.status}`);
  }

  const finalConfig = readConfig();
  finalConfig.git = finalConfig.git || {};
  finalConfig.git.deployed = true;
  writeConfig(finalConfig);

  await generateQrForUrl(publishUrl);
  if (repoCreated) {
    logs.push('First publish detected. Waiting 35s before opening site...');
    await sleep(35000);
  }
  logs.push('Waiting for published site to become available...');
  const siteReady = await waitForPublishedUrl(publishUrl, 90000, 3000);
  if (siteReady) {
    logs.push('Published site is live.');
  } else {
    logs.push('Publish URL still propagating; opening anyway.');
  }
  openUrl(publishUrl);

  return {
    logs: logs.join('\n'),
    publishUrl,
    remoteUrl,
    owner,
    repo,
  };
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'control-server',
      version: apiVersion,
      capabilities: ['publish', 'publish-app', 'reboot', 'link-git', 'switch-git-account', 'build-ehpk', 'square-kds'],
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    try {
      const config = readConfig();
      const secrets = readLocalSecrets();
      sendJson(res, 200, {
        ok: true,
        config: {
          appName: config.appName ?? '',
          publishUrl: config.publishUrl ?? '',
          github: {
            owner: config.github?.owner ?? '',
            repo: config.github?.repo ?? '',
            hasPat: !!String(secrets.githubPat ?? '').trim(),
          },
          git: config.git ?? {},
          square: {
            configured: !!String(secrets.squareAccessToken || '').trim(),
            environment: String(secrets.squareEnvironment || 'sandbox'),
            locationId: String(secrets.squareLocationId || ''),
          },
        },
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/last-publish') {
    sendJson(res, 200, { ok: true, lastPublish });
    return;
  }

  if (req.method === 'POST' && req.url === '/publish') {
    if (publishRunning && Date.now() - publishStartedAt > 130000) {
      publishRunning = false;
      publishStartedAt = 0;
    }

    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Publish already running' });
      return;
    }

    publishRunning = true;
    publishStartedAt = Date.now();
    try {
      const logs = await runPublishLegacy();
      lastPublish = {
        ok: true,
        error: '',
        logs,
        at: new Date().toISOString(),
      };
      sendJson(res, 200, { ok: true, logs });
    } catch (error) {
      const errText = String(error);
      lastPublish = {
        ok: false,
        error: errText,
        logs: errText,
        at: new Date().toISOString(),
      };
      sendJson(res, 500, { ok: false, error: errText, logs: errText });
    } finally {
      publishRunning = false;
      publishStartedAt = 0;
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/publish-app') {
    if (publishRunning && Date.now() - publishStartedAt > 300000) {
      publishRunning = false;
      publishStartedAt = 0;
    }

    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Publish already running' });
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', async () => {
      publishRunning = true;
      publishStartedAt = Date.now();
      try {
        const payload = body ? JSON.parse(body) : {};
        const appNameRaw = String(payload.appName ?? '').trim();
        const appName = appNameRaw || 'even-g2-app';
        const pat = String(payload.pat ?? '').trim();

        const result = await runPublishApp(appName, pat);
        lastPublish = {
          ok: true,
          error: '',
          logs: result.logs,
          at: new Date().toISOString(),
        };
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        const errCode = String(error?.code ?? '').trim();
        const errText = String(error);
        const errMsg = String(error?.message ?? '');
        const isPatRequired = errCode === 'PAT_REQUIRED' || errText.includes('PAT_REQUIRED');
        const isInvalidPat =
          errCode === 'INVALID_PAT' ||
          errText.includes('INVALID_PAT') ||
          errMsg.toLowerCase().includes('invalid github pat');
        lastPublish = {
          ok: false,
          error: errText,
          logs: errText,
          at: new Date().toISOString(),
        };
        sendJson(res, isPatRequired || isInvalidPat ? 400 : 500, {
          ok: false,
          error: isPatRequired ? 'PAT_REQUIRED' : isInvalidPat ? 'INVALID_PAT' : errText,
          code: isPatRequired ? 'PAT_REQUIRED' : isInvalidPat ? 'INVALID_PAT' : undefined,
        });
      } finally {
        publishRunning = false;
        publishStartedAt = 0;
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/build-ehpk') {
    if (ehpkRunning) {
      sendJson(res, 409, { ok: false, error: 'EHPK build already running' });
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', async () => {
      ehpkRunning = true;
      try {
        const payload = body ? JSON.parse(body) : {};
        const appName = String(payload.appName ?? '').trim() || 'even-g2-app';
        const result = await runEhpkBuild(appName);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      } finally {
        ehpkRunning = false;
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/reboot') {
    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Cannot reboot while publish is running' });
      return;
    }

    sendJson(res, 200, { ok: true, message: 'Reboot started' });
    setTimeout(() => {
      try {
        triggerReboot();
      } catch {}
    }, 250);
    return;
  }

  if (req.method === 'POST' && req.url === '/switch-git-account') {
    try {
      triggerSwitchGitAccount();
      sendJson(res, 200, { ok: true, message: 'Opened Git account switch flow.' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/open-github') {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const mode = payload.mode === 'new' ? 'new' : 'login';
        const url = mode === 'new' ? 'https://github.com/new' : 'https://github.com/login';
        openUrl(url);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/config/git') {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        let userName = String(payload.userName ?? '').trim();
        let userEmail = String(payload.userEmail ?? '').trim();
        let githubUser = String(payload.githubUser ?? '').trim();
        let repoName = String(payload.repoName ?? '').trim();
        const branch = String(payload.branch ?? 'main').trim() || 'main';

        if (repoName.endsWith('.git')) {
          repoName = repoName.slice(0, -4);
        }
        if (repoName.includes('/')) {
          const parts = repoName.split('/').filter(Boolean);
          if (parts.length >= 2) {
            githubUser = parts[0];
            repoName = parts[1];
          }
        }

        if (!githubUser || !repoName) {
          sendJson(res, 400, { ok: false, error: 'githubUser and repoName are required' });
          return;
        }

        const config = readConfig();
        const gitCfg = config.git || {};

        if (userName === 'Your Name') userName = '';
        if (userEmail === 'you@example.com') userEmail = '';

        if (!userName) userName = String(gitCfg.userName ?? '').trim();
        if (!userEmail) userEmail = String(gitCfg.userEmail ?? '').trim();
        if (userName === 'Your Name') userName = '';
        if (userEmail === 'you@example.com') userEmail = '';
        if (!userName) userName = githubUser;
        if (!userEmail) userEmail = `${githubUser}@users.noreply.github.com`;

        const remoteUrl = `https://github.com/${githubUser}/${repoName}.git`;
        const publishUrl = `https://${githubUser}.github.io/${repoName}/`;

        config.publishUrl = publishUrl;
        config.github = config.github || {};
        config.github.owner = githubUser;
        config.github.repo = repoName;
        config.git = config.git || {};
        config.git.enabled = true;
        config.git.userName = userName;
        config.git.userEmail = userEmail;
        config.git.remoteUrl = remoteUrl;
        config.git.branch = branch;
        config.git.commitMessagePrefix = config.git.commitMessagePrefix || 'publish';
        config.git.autoSetGithubPagesUrl = true;
        config.git.users = Array.isArray(config.git.users) ? config.git.users : [];
        config.git.repos = Array.isArray(config.git.repos) ? config.git.repos : [];

        if (!config.git.users.some((u) => u?.name === userName && u?.email === userEmail)) {
          config.git.users.push({ name: userName, email: userEmail });
        }
        if (!config.git.repos.includes(remoteUrl)) {
          config.git.repos.push(remoteUrl);
        }

        writeConfig(config);

        if (!fs.existsSync(path.join(projectRoot, '.git'))) {
          await runGit(['init', '-b', branch]);
        }
        await runGit(['config', 'user.name', userName]);
        await runGit(['config', 'user.email', userEmail]);
        await runGit(['config', 'credential.helper', 'manager']);

        try {
          await runGit(['remote', 'add', 'origin', remoteUrl]);
        } catch {
          await runGit(['remote', 'set-url', 'origin', remoteUrl]);
        }

        sendJson(res, 200, { ok: true, remoteUrl, publishUrl });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/square/orders') {
    sendJson(res, 200, {
      ok: true,
      orders: squareOrderCache,
      fetchedAt: squareCacheAt,
      syncStatus: squareFetchRunning ? 'POLLING' : (squareCacheAt > 0 ? 'OK' : 'IDLE'),
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/square/orders/complete') {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const orderId = String(payload.orderId || '').trim();
        if (!orderId) {
          sendJson(res, 400, { ok: false, error: 'orderId required' });
          return;
        }
        const result = await markOrderComplete(orderId);
        if (result.ok) {
          pendingSuppressIds.set(orderId, Date.now());
          squareOrderCache = squareOrderCache.filter((o) => o.id !== orderId);
          void fetchSquareOrders();
        }
        sendJson(res, result.ok ? 200 : 500, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/square/orders/prepared') {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const orderId = String(payload.orderId || '').trim();
        if (!orderId) {
          sendJson(res, 400, { ok: false, error: 'orderId required' });
          return;
        }
        const result = await markOrderPrepared(orderId);
        if (result.ok) void fetchSquareOrders();
        sendJson(res, result.ok ? 200 : 500, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/square/refresh') {
    await fetchSquareOrders();
    sendJson(res, 200, { ok: true, count: squareOrderCache.length, fetchedAt: squareCacheAt });
    return;
  }

  if (req.method === 'POST' && req.url === '/square/config') {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const secrets = readLocalSecrets();
        if (payload.accessToken !== undefined) secrets.squareAccessToken = String(payload.accessToken).trim();
        if (payload.locationId !== undefined) secrets.squareLocationId = String(payload.locationId).trim();
        if (payload.environment !== undefined) secrets.squareEnvironment = String(payload.environment).trim();
        writeLocalSecrets(secrets);
        startSquarePoll();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/square/clear-orders') {
    try {
      const { accessToken, locationId } = readSquareSecrets();
      if (!accessToken || !locationId) {
        sendJson(res, 400, { ok: false, error: 'Square not configured' });
        return;
      }

      let deleted = 0;
      let failed = 0;
      const snapshot = [...squareOrderCache];
      for (const order of snapshot) {
        try {
          const result = await markOrderComplete(order.id);
          if (result.ok) { deleted++; pendingSuppressIds.set(order.id, Date.now()); } else { failed++; }
        } catch { failed++; }
      }

      squareOrderCache = [];
      squareCacheAt = Date.now();
      void fetchSquareOrders();
      sendJson(res, 200, { ok: true, deleted, failed });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/square/create-test-order') {
    try {
      const result = await createTestOrder();
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/square/status') {
    const { accessToken, locationId, environment } = readSquareSecrets();
    sendJson(res, 200, {
      ok: true,
      configured: !!(accessToken && locationId),
      lastFetchAt: squareCacheAt,
      orderCount: squareOrderCache.length,
      environment,
      fetchRunning: squareFetchRunning,
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, host, () => {
  console.log(`[control] listening on http://${host}:${port}`);
});

// Start Square polling if credentials are already saved
{
  const bootSecrets = readLocalSecrets();
  if (bootSecrets.squareAccessToken && bootSecrets.squareLocationId) {
    startSquarePoll();
  }
}
