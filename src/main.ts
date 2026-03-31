import './style.css';
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

type InputAction = 'CLICK' | 'UP' | 'DOWN' | 'DOUBLE_CLICK';
type KdsMode = 'ORDERS' | 'ORDER_DETAIL' | 'CONFIRM';

type KdsOrder = {
  id: string;
  displayId: string;
  customerName: string;
  itemLines: string[];
  noteLines: string[];
  createdAt: number;
  state: string;
  fulfillmentState: string;
  version: number;
};

type ConfirmChoice = 'COMPLETE' | 'NOT_HERE';

type AppState = {
  hudMode: KdsMode;
  orders: KdsOrder[];
  notHereOrders: KdsOrder[];
  notHereAt: Record<string, number>;
  selectedIndex: number;
  confirmChoice: ConfirmChoice;
  filterOpenOnly: boolean;
  lastSync: number;
  syncStatus: 'OK' | 'POLLING' | 'ERROR' | 'IDLE';
  lastAction: string;
  publishStatus: string;
  deployed: boolean;
};

const MAIN_CONTAINER_ID = 1;
const MAIN_CONTAINER_NAME = 'mainText';
const CONTROL_URL = 'http://127.0.0.1:8787';
const REQUIRED_CONTROL_CAPABILITY = 'square-kds';
const DISPLAY_WIDTH = 576;
const MAIN_PANEL_X = 24;
const MAIN_PANEL_WIDTH = 528;
const HIDE_DEBUG_TOOLS = true;
const DEV_TOOLS_TOGGLE_SHORTCUT = 'Ctrl+Shift+D';
const MAX_APP_NAME_LENGTH = 20;
const LINE_WIDTH = 56;


const state: AppState = {
  hudMode: 'ORDERS',
  orders: [],
  notHereOrders: [],
  notHereAt: {},
  selectedIndex: 0,
  confirmChoice: 'COMPLETE',
  filterOpenOnly: true,
  lastSync: 0,
  syncStatus: 'IDLE',
  lastAction: 'Starting...',
  publishStatus: 'IDLE',
  deployed: false,
};

let bridge: EvenAppBridge | null = null;
let startupCreated = false;
let lastResolvedAction: InputAction | null = null;
let lastResolvedActionAt = 0;
let lastEventSignature = '';
let lastEventAt = 0;
let lastEventLabel = '';
let debugToolsVisible = !HIDE_DEBUG_TOOLS;
let lastCompletedName = '';
let lastCompletedAt = 0;
let nhPanOffset = 0; // character pan position for not-here banner
// Grace period set: IDs optimistically removed pending Square confirmation (cleared after 30s)
const pendingCompleteIds = new Map<string, number>(); // id → timestamp

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root element');

app.innerHTML = `
  <main class="hud-shell">
    <fieldset class="group-box">
      <legend>Square KDS Config</legend>
      <div class="settings-row">
        <div class="mini-field wide-field">
          <label for="square-token">Access Token</label>
          <input id="square-token" type="password" placeholder="EAAAl..." autocomplete="off" />
        </div>
        <span id="kds-status-dot" class="kds-status-dot kds-dot-idle" title="Not configured"></span>
      </div>
      <div class="settings-row">
        <div class="mini-field wide-field">
          <label for="square-location">Location ID</label>
          <input id="square-location" type="text" placeholder="L..." />
        </div>
      </div>
      <div class="settings-row">
        <div class="mini-field">
          <label for="square-env">Environment</label>
          <select id="square-env">
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </div>
      </div>
      <div class="settings-row">
        <button id="square-save-btn" type="button">Save &amp; Connect</button>
        <span id="square-status-text" class="hint" style="margin:0;"></span>
      </div>
      <div class="settings-row">
        <div class="mini-field">
          <label for="urgent-mins">Urgent after</label>
          <input id="urgent-mins" type="number" min="1" max="60" value="10" />
          <span class="field-unit">min</span>
        </div>
      </div>
      <p class="hint">On glasses: Up/Down=scroll, Click=open order, Double-click=refresh</p>
      <p class="hint">In order detail: Click=mark done, Double-click=back</p>
    </fieldset>

    <fieldset id="debug-tools" class="group-box" ${HIDE_DEBUG_TOOLS ? 'style="display:none;"' : ''}>
      <legend>Debug Tools</legend>
      <div class="controls">
        <button id="publish-btn" type="button">Publish App</button>
        <button id="ehpk-btn" type="button">Build EHPK</button>
        <button id="test-order-btn" type="button">+ Test Order</button>
        <button id="clear-orders-btn" type="button">Clear All Orders</button>
        <span id="publish-status">IDLE</span>
      </div>
      <pre id="event-log" class="event-log"></pre>
      <pre id="publish-log" class="publish-log"></pre>

      <div class="sim-display">
        <pre id="hud-main-preview" class="hud-preview hud-preview-main"></pre>
      </div>
      <p class="hint">Keyboard simulation: Enter=Click, Arrow Up/Down, D=Double-click</p>
    </fieldset>
  </main>
`;

const hudMainPreview = document.querySelector<HTMLPreElement>('#hud-main-preview')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const ehpkBtn = document.querySelector<HTMLButtonElement>('#ehpk-btn')!;
const debugToolsFieldset = document.querySelector<HTMLElement>('#debug-tools')!;
const testOrderBtn = document.querySelector<HTMLButtonElement>('#test-order-btn')!;
const clearOrdersBtn = document.querySelector<HTMLButtonElement>('#clear-orders-btn')!;
const publishStatus = document.querySelector<HTMLSpanElement>('#publish-status')!;
const eventLog = document.querySelector<HTMLPreElement>('#event-log')!;
const publishLog = document.querySelector<HTMLPreElement>('#publish-log')!;
const squareTokenInput = document.querySelector<HTMLInputElement>('#square-token')!;
const squareLocationInput = document.querySelector<HTMLInputElement>('#square-location')!;
const squareEnvSelect = document.querySelector<HTMLSelectElement>('#square-env')!;
const squareSaveBtn = document.querySelector<HTMLButtonElement>('#square-save-btn')!;
const squareStatusText = document.querySelector<HTMLSpanElement>('#square-status-text')!;
const kdsStatusDot = document.querySelector<HTMLSpanElement>('#kds-status-dot')!;
const eventLines: string[] = [];

const mainPanelLeftPercent = (MAIN_PANEL_X / DISPLAY_WIDTH) * 100;
const mainPanelWidthPercent = (MAIN_PANEL_WIDTH / DISPLAY_WIDTH) * 100;
hudMainPreview.style.left = `${mainPanelLeftPercent}%`;
hudMainPreview.style.width = `${mainPanelWidthPercent}%`;

function clampAppName(value: string): string {
  return String(value || '').trim().slice(0, MAX_APP_NAME_LENGTH);
}

function truncateName(name: string, maxLen: number): string {
  const n = (name || 'Unknown').trim();
  if (n.length <= maxLen) return n;
  return n.slice(0, maxLen - 1) + '\u2026';
}

let urgentMinutes = 10; // configurable via browser UI

function isUrgent(createdAtMs: number): boolean {
  return (Date.now() - createdAtMs) > urgentMinutes * 60 * 1000;
}

function formatOrderRow(order: KdsOrder, selected: boolean): string {
  const cursor = selected ? '>' : ' ';
  // name up to 10 chars, then wait time mm:ss, then item names
  const name = truncateName(order.customerName, 10).padEnd(10);
  const wait = formatWaitTime(Date.now() - order.createdAt);
  const urgent = isUrgent(order.createdAt) ? '!' : ' ';
  // item names joined, truncated to fill remaining space
  const topItems = order.itemLines
    .filter(l => !l.startsWith('   '))
    .map(l => l.replace(/^\d+ x /, ''))
    .join(', ');
  // layout: cursor(1) name(10) space(1) wait(5) urgent(1) = 18 chars used; rest for items
  const itemsMaxLen = LINE_WIDTH - 18;
  const itemsSummary = truncateName(topItems, itemsMaxLen);
  return `${cursor}${name} ${urgent}${wait} ${itemsSummary}`;
}

function syncHeaderLine(): string {
  const age = state.lastSync > 0 ? Math.floor((Date.now() - state.lastSync) / 1000) : -1;
  if (state.syncStatus === 'ERROR' || age > 120) return '[ KDS OFFLINE ]';
  if (age > 30 || state.syncStatus === 'IDLE') return   '[ KDS ~stale ]';
  if (lastCompletedName && Date.now() - lastCompletedAt < 5000) {
    return `Done: ${truncateName(lastCompletedName, 10)}`;
  }
  return '[ KDS ONLINE ]';
}

function formatWaitTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins.toString().padStart(2, '0')}m${secs.toString().padStart(2, '0')}s`;
}

// Helpers: unified index — not-here orders occupy 0..nhCount-1, open orders nhCount..total-1
// This means UP in detail view naturally navigates from open orders into not-here orders above.
function isNotHereIdx(idx: number): boolean { return idx < state.notHereOrders.length; }
function getOrderAtIdx(idx: number): KdsOrder | null {
  if (idx < 0) return null;
  if (idx < state.notHereOrders.length) return state.notHereOrders[idx];
  const openIdx = idx - state.notHereOrders.length;
  return state.orders[openIdx] ?? null;
}

function buildOrdersHudText(): string {
  const header = syncHeaderLine();
  const openCount = state.orders.length;
  const nhCount = state.notHereOrders.length;
  const headerLine = nhCount > 0
    ? `${header} | ${nhCount} Not Here | ${openCount} Open`
    : `${header} | ${openCount} Order${openCount !== 1 ? 's' : ''}:`;

  if (openCount === 0 && nhCount === 0) {
    return [headerLine, '', '  No open orders', '', '', '', '', '', '', 'DBL:Refresh'].join('\n');
  }

  // Build virtual display rows: not-here orders first (at top), then separator, then open orders.
  // Index scheme: not-here = 0..nhCount-1, open = nhCount..total-1
  type VRow = { text: string; selIdx: number | null };
  const rows: VRow[] = [];
  for (let i = 0; i < nhCount; i++) {
    rows.push({ text: formatOrderRow(state.notHereOrders[i], state.selectedIndex === i), selIdx: i });
  }
  if (nhCount > 0 && openCount > 0) {
    rows.push({ text: `\u2500\u2500 ${openCount} Open \u2500\u2500`, selIdx: null }); // ── X Open ──
  }
  for (let i = 0; i < openCount; i++) {
    const globalIdx = nhCount + i;
    rows.push({ text: formatOrderRow(state.orders[i], state.selectedIndex === globalIdx), selIdx: globalIdx });
  }

  // Window: 8 visible rows, keep selected row visible
  const WIN = 8;
  const selDisplayRow = rows.findIndex(r => r.selIdx === state.selectedIndex);
  let winStart = selDisplayRow >= 0 ? Math.max(0, selDisplayRow - 3) : 0;
  const winEnd = Math.min(rows.length, winStart + WIN);
  winStart = Math.max(0, winEnd - WIN);

  const lines: string[] = [headerLine];
  for (let r = winStart; r < winEnd; r++) lines.push(rows[r].text);
  while (lines.length <= 8) lines.push('');
  lines.push('CLICK:Open  DBL:Refresh');
  return lines.join('\n');
}

function formatNotHereWait(id: string): string {
  const ts = state.notHereAt[id];
  if (!ts) return '?';
  return `${Math.floor((Date.now() - ts) / 60000).toString().padStart(2, '0')}m`;
}

function buildNotHereSummary(): string {
  const nh = state.notHereOrders;
  if (nh.length === 0) return '';
  const parts = nh.map(o => {
    const name = truncateName(o.customerName, 5);
    const cnt = o.itemLines.filter(l => !l.startsWith('   ')).length;
    return `${name}[${cnt}]${formatNotHereWait(o.id)}`;
  });
  return `${nh.length} Not Here: ${parts.join(' | ')}`;
}

function buildOrderDetailHudText(): string {
  const isNh = isNotHereIdx(state.selectedIndex);
  const order = getOrderAtIdx(state.selectedIndex);
  if (!order) return 'No order selected\n\n\n\n\nDBL:Back';

  const wait = formatWaitTime(Date.now() - order.createdAt);
  const itemCount = order.itemLines.filter(l => !l.startsWith('   ')).length;
  const nhSummary = buildNotHereSummary();
  const orderHeader = `${truncateName(order.customerName, 14)}  [${itemCount}]  ${wait}`;

  const lines: string[] = [];
  if (nhSummary) {
    lines.push(nhSummary);
    lines.push('-'.repeat(18));
  }
  lines.push(orderHeader);
  // For not-here orders: replace the separator with a MADE badge so it's obvious the food is ready
  lines.push(isNh ? '[ MADE \u2014 HAND OFF ]' : '-'.repeat(18));

  const contentLines = [...order.itemLines, ...order.noteLines];
  const maxItems = nhSummary ? 3 : 5;
  for (let i = 0; i < Math.min(maxItems, contentLines.length); i++)
    lines.push(isNh?' *** '+contentLines[i]:contentLines[i]);

  // Pad so the footer always sits at the bottom of the display (9 lines total)
  while (lines.length <= 8) lines.push('');
  lines.push(isNh ? 'CLICK:Pickup  DBL:Back' : 'CLICK:Done  DBL:Back');
  return lines.join('\n');
}

function buildConfirmHudText(): string {
  const isNh = isNotHereIdx(state.selectedIndex);
  const order = getOrderAtIdx(state.selectedIndex);
  if (!order) return 'No order\n\n\n\n\nDBL:Back';

  const wait = formatWaitTime(Date.now() - order.createdAt);
  const itemNames = order.itemLines
    .filter(l => !l.startsWith('   '))
    .map(l => l.replace(/^\d+ x /, ''))
    .slice(0, 2);
  const summary = truncateName(itemNames.join(', '), LINE_WIDTH);

  const opt1 = isNh ? 'PICKED UP' : 'COMPLETE';
  const opt2 = isNh ? 'STILL AWAY' : 'NOT HERE';

  return [
    `${truncateName(order.customerName, 14)}  ${wait}`,
    summary,
    '-'.repeat(18),
    state.confirmChoice === 'COMPLETE' ? `> ${opt1}` : `  ${opt1}`,
    state.confirmChoice === 'NOT_HERE' ? `> ${opt2}` : `  ${opt2}`,
    '-'.repeat(18),
    'CLICK:Confirm  DBL:Back',
  ].join('\n');
}

function buildMainHudText(): string {
  if (state.hudMode === 'ORDER_DETAIL') return buildOrderDetailHudText();
  if (state.hudMode === 'CONFIRM') return buildConfirmHudText();
  return buildOrdersHudText();
}

async function pushHudToEvenHub(): Promise<void> {
  if (!bridge || !startupCreated) return;

  const mainContent = buildMainHudText();

  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: MAIN_CONTAINER_ID,
      containerName: MAIN_CONTAINER_NAME,
      contentOffset: 0,
      contentLength: mainContent.length,
      content: mainContent,
    }),
  );
}

async function render(): Promise<void> {
  hudMainPreview.textContent = buildMainHudText();
  publishStatus.textContent = state.publishStatus;
  publishBtn.textContent = state.deployed ? 'Update App' : 'Publish App';

  // Update status dot
  const age = state.lastSync > 0 ? Math.floor((Date.now() - state.lastSync) / 1000) : -1;
  if (state.syncStatus === 'ERROR' || age > 120) {
    kdsStatusDot.className = 'kds-status-dot kds-dot-error';
    kdsStatusDot.title = 'Offline';
  } else if (age > 30 || state.syncStatus === 'IDLE') {
    kdsStatusDot.className = 'kds-status-dot kds-dot-warn';
    kdsStatusDot.title = 'Stale';
  } else {
    kdsStatusDot.className = 'kds-status-dot kds-dot-ok';
    kdsStatusDot.title = 'Connected';
  }

  try {
    await pushHudToEvenHub();
  } catch (error) {
    console.error('Failed to push HUD update to Even Hub:', error);
  }
}

async function completeOrder(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${CONTROL_URL}/square/orders/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id }),
    });
    const body = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    return { ok: !!body?.ok, error: body?.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function prepareOrder(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${CONTROL_URL}/square/orders/prepared`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id }),
    });
    const body = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    return { ok: !!body?.ok, error: body?.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function pollOrders(): Promise<void> {
  try {
    const resp = await fetch(`${CONTROL_URL}/square/orders`, { cache: 'no-store' });
    if (!resp.ok) {
      state.syncStatus = 'ERROR';
      return;
    }
    const body = await resp.json() as {
      orders?: KdsOrder[];
      fetchedAt?: number;
      syncStatus?: 'OK' | 'POLLING' | 'ERROR' | 'IDLE';
    };

    const incoming: KdsOrder[] = body.orders ?? [];
    state.lastSync = body.fetchedAt ?? Date.now();
    state.syncStatus = body.syncStatus ?? 'OK';

    // Prune pending completions older than 30s (Square should have confirmed by then)
    const now = Date.now();
    for (const [id, ts] of pendingCompleteIds) {
      if (now - ts > 30000) pendingCompleteIds.delete(id);
    }

    // Auto-promote PREPARED orders into not-here (persists across glass restarts)
    for (const o of incoming) {
      if (o.fulfillmentState === 'PREPARED' && !state.notHereAt[o.id] && !pendingCompleteIds.has(o.id)) {
        if (!state.notHereOrders.find(n => n.id === o.id)) {
          state.notHereOrders = [...state.notHereOrders, o];
        }
        state.notHereAt[o.id] = state.notHereAt[o.id] ?? Date.now();
      }
    }

    // Keep not-here orders in sync — remove any that no longer exist in Square
    const incomingIds = new Set(incoming.map(o => o.id));
    state.notHereOrders = state.notHereOrders.filter(o => incomingIds.has(o.id));
    for (const id of Object.keys(state.notHereAt)) {
      if (!incomingIds.has(id)) delete state.notHereAt[id];
    }

    // Main list excludes not-here orders (PREPARED) and orders we just completed (grace period)
    const notHereIds = new Set(state.notHereOrders.map(o => o.id));
    const mainOrders = incoming.filter(o => !notHereIds.has(o.id) && !pendingCompleteIds.has(o.id));
    const mainSig = mainOrders.map(o => `${o.id}:${o.state}`).join(',');
    const prevMainSig = state.orders.map(o => `${o.id}:${o.state}`).join(',');

    if (mainSig !== prevMainSig) {
      const prevLen = state.orders.length;
      state.orders = mainOrders;
      const newTotal = state.notHereOrders.length + mainOrders.length;
      state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, newTotal - 1));
      if (mainOrders.length > prevLen) state.lastAction = 'New order!';
      await render();
    }
  } catch {
    state.syncStatus = 'ERROR';
  }
}

async function applyAction(action: InputAction): Promise<void> {
  if (state.hudMode === 'ORDERS') {
    const max = Math.max(0, state.orders.length + state.notHereOrders.length - 1);
    if (action === 'UP') state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    if (action === 'DOWN') state.selectedIndex = Math.min(max, state.selectedIndex + 1);
    if (action === 'CLICK' && getOrderAtIdx(state.selectedIndex)) {
      state.hudMode = 'ORDER_DETAIL';
    }
    if (action === 'DOUBLE_CLICK') {
      state.lastAction = 'Refreshing...';
      await render();
      await fetch(`${CONTROL_URL}/square/refresh`, { method: 'POST' }).catch(() => null);
      await pollOrders();
    }
    await render();
    return;
  }

  if (state.hudMode === 'ORDER_DETAIL') {
    const max = Math.max(0, state.orders.length + state.notHereOrders.length - 1);
    if (action === 'UP') state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    if (action === 'DOWN') state.selectedIndex = Math.min(max, state.selectedIndex + 1);
    if (action === 'CLICK') {
      state.hudMode = 'CONFIRM';
      state.confirmChoice = 'COMPLETE';
    }
    if (action === 'DOUBLE_CLICK') state.hudMode = 'ORDERS';
    await render();
    return;
  }

  if (state.hudMode === 'CONFIRM') {
    if (action === 'UP') state.confirmChoice = 'COMPLETE';
    if (action === 'DOWN') state.confirmChoice = 'NOT_HERE';
    if (action === 'CLICK') {
      const isNh = isNotHereIdx(state.selectedIndex);
      const order = getOrderAtIdx(state.selectedIndex);
      if (order) {
        if (isNh) {
          // Not-here order: PICKED UP = complete in Square, STILL AWAY = leave in not-here list
          if (state.confirmChoice === 'COMPLETE') {
            state.lastAction = `Completing ${order.displayId}...`;
            await render();
            const result = await completeOrder(order.id);
            if (result.ok) {
              pendingCompleteIds.set(order.id, Date.now());
              lastCompletedName = order.customerName;
              lastCompletedAt = Date.now();
              state.notHereOrders = state.notHereOrders.filter(o => o.id !== order.id);
              delete state.notHereAt[order.id];
              state.lastAction = `Done: ${order.customerName}`;
            } else {
              state.lastAction = `Fail: ${result.error ?? 'unknown'}`;
              publishLog.textContent = `Complete failed: ${result.error ?? 'unknown'}`;
            }
          }
          // STILL AWAY: do nothing, just go back
          // Index scheme: nh=0..nhCount-1, open=nhCount..total-1. Clamp to valid range.
          state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.notHereOrders.length + state.orders.length - 1));
        } else {
          // Open order: COMPLETE = mark done, NOT HERE = move to not-here queue
          if (state.confirmChoice === 'COMPLETE') {
            state.lastAction = `Completing ${order.displayId}...`;
            await render();
            const result = await completeOrder(order.id);
            if (result.ok) {
              pendingCompleteIds.set(order.id, Date.now());
              lastCompletedName = order.customerName;
              lastCompletedAt = Date.now();
              state.lastAction = `Done: ${order.customerName}`;
              state.orders = state.orders.filter(o => o.id !== order.id);
              // Keep selectedIndex pointing at next open order; clamp to valid total range
              const newTotal = state.notHereOrders.length + state.orders.length;
              state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, newTotal - 1));
              // Don't let index fall below start of open range if open orders still exist
              if (state.orders.length > 0) {
                state.selectedIndex = Math.max(state.selectedIndex, state.notHereOrders.length);
              }
            } else {
              state.lastAction = `Fail: ${result.error ?? 'unknown'}`;
              publishLog.textContent = `Complete failed: ${result.error ?? 'unknown'}`;
            }
          } else {
            // NOT HERE: move to not-here list + mark PREPARED in Square
            state.notHereOrders = [...state.notHereOrders.filter(o => o.id !== order.id), order];
            state.notHereAt[order.id] = Date.now();
            state.orders = state.orders.filter(o => o.id !== order.id);
            // Point at first open order, or last not-here if no open orders remain
            state.selectedIndex = state.orders.length > 0
              ? state.notHereOrders.length
              : Math.max(0, state.notHereOrders.length - 1);
            state.lastAction = `Not here: ${order.customerName}`;
            // Fire-and-forget — don't block the UI on this
            void prepareOrder(order.id);
          }
        }
      }
      const total = state.orders.length + state.notHereOrders.length;
      state.hudMode = total > 0 ? 'ORDER_DETAIL' : 'ORDERS';
    }
    if (action === 'DOUBLE_CLICK') state.hudMode = 'ORDER_DETAIL';
    await render();
    return;
  }

  await render();
}

function mapEventTypeToAction(eventType: unknown): InputAction | null {
  if (eventType === undefined || eventType === null) return null;

  const normalized = OsEventTypeList.fromJson?.(eventType);
  if (normalized === OsEventTypeList.CLICK_EVENT) return 'CLICK';
  if (normalized === OsEventTypeList.SCROLL_TOP_EVENT) return 'UP';
  if (normalized === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'DOWN';
  if (normalized === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'DOUBLE_CLICK';

  if (eventType === OsEventTypeList.CLICK_EVENT || eventType === 0) return 'CLICK';
  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT || eventType === 1) return 'UP';
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === 2) return 'DOWN';
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT || eventType === 3) return 'DOUBLE_CLICK';

  const text = String(eventType).toUpperCase();
  if (text.includes('DOUBLE') && text.includes('CLICK')) return 'DOUBLE_CLICK';
  if (text.includes('DOUBLE') && text.includes('TAP')) return 'DOUBLE_CLICK';
  if (text.includes('SCROLL_TOP') || text === 'UP' || text.includes('SWIPE_UP')) return 'UP';
  if (text.includes('SCROLL_BOTTOM') || text === 'DOWN' || text.includes('SWIPE_DOWN')) return 'DOWN';
  if (text.includes('SINGLE') && text.includes('CLICK')) return 'CLICK';
  if (text.includes('SINGLE') && text.includes('TAP')) return 'CLICK';
  if (text.includes('TAP_EVENT') || text === 'TAP') return 'CLICK';
  if (text === 'CLICK' || text.includes('CLICK_EVENT')) return 'CLICK';

  return null;
}

function extractEventType(event: any): unknown {
  return (
    event?.listEvent?.eventType ??
    event?.textEvent?.eventType ??
    event?.sysEvent?.eventType ??
    event?.listEvent?.eventName ??
    event?.textEvent?.eventName ??
    event?.sysEvent?.eventName ??
    event?.listEvent?.type ??
    event?.textEvent?.type ??
    event?.sysEvent?.type ??
    event?.eventType ??
    event?.type ??
    event?.name
  );
}

function appendEventLog(line: string): void {
  eventLines.push(line);
  while (eventLines.length > 8) {
    eventLines.shift();
  }
  eventLog.textContent = eventLines.join('\n');
}

function shouldTreatEmptySysEventAsClick(event: any): boolean {
  const explicitType = extractEventType(event);
  if (mapEventTypeToAction(explicitType)) return false;

  const now = Date.now();
  if (lastResolvedAction === 'DOUBLE_CLICK' && now - lastResolvedActionAt < 350) return false;
  return true;
}

function isDuplicateEvent(event: any, eventLabel: string): boolean {
  const signature = JSON.stringify({
    listEvent: event?.listEvent ?? null,
    textEvent: event?.textEvent ?? null,
    sysEvent: event?.sysEvent ?? null,
    eventType: event?.eventType ?? null,
    type: event?.type ?? null,
  });

  const now = Date.now();
  if (eventLabel === lastEventLabel && signature === lastEventSignature && now - lastEventAt < 140) {
    return true;
  }

  lastEventLabel = eventLabel;
  lastEventSignature = signature;
  lastEventAt = now;
  return false;
}

async function createStartupPage(): Promise<void> {
  if (!bridge) return;

  const mainContent = buildMainHudText();
  const containerPayload = {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: MAIN_PANEL_X,
        yPosition: 0,
        width: MAIN_PANEL_WIDTH,
        height: 288,
        containerID: MAIN_CONTAINER_ID,
        containerName: MAIN_CONTAINER_NAME,
        content: mainContent,
        isEventCapture: 1,
      }),
    ],
  };

  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containerPayload));
  startupCreated = result === 0;
  if (startupCreated) {
    return;
  }

  console.warn('createStartUpPageContainer failed with code:', result, 'trying rebuildPageContainer...');
  const rebuildOk = await bridge.rebuildPageContainer(new RebuildPageContainer(containerPayload));
  startupCreated = !!rebuildOk;
  if (!startupCreated) {
    console.warn('rebuildPageContainer also failed');
  }
}

async function publishApp(): Promise<void> {
  if (state.publishStatus === 'RUNNING') {
    publishLog.textContent = 'Publish is already running. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configResponse?.json().catch(() => null)) as
    | { config?: { appName?: string; github?: { repo?: string } } }
    | null;

  const savedRepoName = (configBody?.config?.github?.repo ?? '').trim();
  const defaultAppName = clampAppName(savedRepoName || configBody?.config?.appName || 'square-kds');
  let appName = defaultAppName;

  if (!savedRepoName) {
    const appNameInput = window.prompt(`App name (max ${MAX_APP_NAME_LENGTH} chars):`, defaultAppName);
    appName = clampAppName(appNameInput ?? '');
    if (!appName) {
      publishLog.textContent = 'Publish cancelled: app name is required.';
      await render();
      return;
    }
  }

  state.publishStatus = 'RUNNING';
  publishBtn.disabled = true;
  ehpkBtn.disabled = true;
  publishLog.textContent = `Publishing "${appName}"...`;
  await render();

  try {
    let response = await fetch(`${CONTROL_URL}/publish-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName }),
    });

    let body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; code?: string; publishUrl?: string }
      | null;

    if (!response.ok && (body?.code === 'PAT_REQUIRED' || body?.code === 'INVALID_PAT')) {
      const promptText =
        body?.code === 'INVALID_PAT'
          ? 'Saved PAT is invalid. Paste a new GitHub PAT:'
          : 'GitHub PAT required. Paste PAT:';
      const pat = window.prompt(promptText);
      if (!pat || !pat.trim()) {
        throw new Error('Publish cancelled: PAT is required.');
      }
      response = await fetch(`${CONTROL_URL}/publish-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName, pat: pat.trim() }),
      });
      body = (await response.json().catch(() => null)) as
        | { error?: string; logs?: string; publishUrl?: string }
        | null;
    }

    if (!response.ok) {
      if (response.status === 409) {
        state.publishStatus = 'RUNNING';
        publishLog.textContent = 'Publish already running. Please wait for it to complete.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
    state.deployed = true;
    publishLog.textContent = `${body?.logs ?? 'Publish complete.'}\n\nPublished URL:\n${body?.publishUrl ?? 'unknown'}`;
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

async function buildEhpk(): Promise<void> {
  if (state.publishStatus === 'RUNNING' || state.publishStatus === 'REBOOTING' || state.publishStatus === 'PACKING') {
    publishLog.textContent = 'Another operation is in progress. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configResponse?.json().catch(() => null)) as { config?: { appName?: string } } | null;
  const defaultAppName = clampAppName((configBody?.config?.appName ?? 'square-kds').trim() || 'square-kds');

  const appNameInput = window.prompt(`App name for .ehpk package (max ${MAX_APP_NAME_LENGTH} chars):`, defaultAppName);
  const appName = clampAppName(appNameInput ?? '');
  if (!appName) {
    publishLog.textContent = 'Build cancelled: app name is required.';
    await render();
    return;
  }

  state.publishStatus = 'PACKING';
  publishBtn.disabled = true;
  ehpkBtn.disabled = true;
  publishLog.textContent = `Building .ehpk for "${appName}"...`;
  await render();

  try {
    const response = await fetch(`${CONTROL_URL}/build-ehpk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName }),
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; outputPath?: string }
      | null;

    if (!response.ok) {
      if (response.status === 409) {
        state.publishStatus = 'PACKING';
        publishLog.textContent = 'EHPK build already running. Please wait for it to finish.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
    publishLog.textContent = `${body?.logs ?? 'EHPK build complete.'}\n\nOutput:\n${body?.outputPath ?? 'unknown'}`;
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

function setKeyboardFallback(): void {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      debugToolsVisible = !debugToolsVisible;
      debugToolsFieldset.style.display = debugToolsVisible ? '' : 'none';
      console.log(`[debug-tools] ${debugToolsVisible ? 'shown' : 'hidden'} (${DEV_TOOLS_TOGGLE_SHORTCUT})`);
      return;
    }

    if (event.key === 'Enter') return void applyAction('CLICK');
    if (event.key === 'ArrowUp') return void applyAction('UP');
    if (event.key === 'ArrowDown') return void applyAction('DOWN');
    if (event.key.toLowerCase() === 'd') return void applyAction('DOUBLE_CLICK');
  });
}

async function init(): Promise<void> {
  setKeyboardFallback();

  publishBtn.addEventListener('click', () => void publishApp());
  ehpkBtn.addEventListener('click', () => void buildEhpk());

  testOrderBtn.addEventListener('click', async () => {
    testOrderBtn.disabled = true;
    testOrderBtn.textContent = 'Creating...';
    try {
      const resp = await fetch(`${CONTROL_URL}/square/create-test-order`, { method: 'POST' });
      const body = await resp.json().catch(() => null) as { ok?: boolean; customerName?: string; error?: string } | null;
      if (body?.ok) {
        publishLog.textContent = `Test order created for ${body.customerName ?? 'unknown'}.`;
        await pollOrders();
      } else {
        publishLog.textContent = `Test order failed: ${body?.error ?? 'unknown'}`;
      }
    } catch (e) {
      publishLog.textContent = `Test order error: ${String(e)}`;
    } finally {
      testOrderBtn.disabled = false;
      testOrderBtn.textContent = '+ Test Order';
    }
  });

  clearOrdersBtn.addEventListener('click', async () => {
    clearOrdersBtn.disabled = true;
    clearOrdersBtn.textContent = 'Clearing...';
    try {
      const resp = await fetch(`${CONTROL_URL}/square/clear-orders`, { method: 'POST' });
      const body = await resp.json().catch(() => null) as { ok?: boolean; deleted?: number; failed?: number; error?: string } | null;
      if (body?.ok) {
        state.orders = [];
        state.notHereOrders = [];
        state.notHereAt = {};
        state.selectedIndex = 0;
        state.hudMode = 'ORDERS';
        publishLog.textContent = `Cleared ${body.deleted ?? 0} orders${body.failed ? `, ${body.failed} failed` : ''}.`;
        await render();
      } else {
        publishLog.textContent = `Clear failed: ${body?.error ?? 'unknown'}`;
      }
    } catch (e) {
      publishLog.textContent = `Clear error: ${String(e)}`;
    } finally {
      clearOrdersBtn.disabled = false;
      clearOrdersBtn.textContent = 'Clear All Orders';
    }
  });

  const urgentMinsInput = document.querySelector<HTMLInputElement>('#urgent-mins')!;
  urgentMinsInput.addEventListener('change', () => {
    const v = parseInt(urgentMinsInput.value, 10);
    if (v >= 1 && v <= 60) urgentMinutes = v;
  });

  squareSaveBtn.addEventListener('click', async () => {
    const accessToken = squareTokenInput.value.trim();
    const locationId = squareLocationInput.value.trim();
    const environment = squareEnvSelect.value;

    if (!accessToken || !locationId) {
      squareStatusText.textContent = 'Token and Location ID required.';
      return;
    }

    squareSaveBtn.disabled = true;
    squareStatusText.textContent = 'Saving...';

    try {
      const resp = await fetch(`${CONTROL_URL}/square/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, locationId, environment }),
      });
      const body = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (body?.ok) {
        squareStatusText.textContent = 'Saved. Connecting...';
        await pollOrders();
        squareStatusText.textContent = `Connected. ${state.orders.length} open orders.`;
      } else {
        squareStatusText.textContent = `Error: ${body?.error ?? 'Unknown'}`;
      }
    } catch (err) {
      squareStatusText.textContent = `Error: ${String(err)}`;
    } finally {
      squareSaveBtn.disabled = false;
    }
  });

  try {
    const health = await fetch(`${CONTROL_URL}/health`, { cache: 'no-store' });
    const info = (await health.json().catch(() => null)) as { capabilities?: string[]; version?: string } | null;
    if (!health.ok || !info?.capabilities?.includes(REQUIRED_CONTROL_CAPABILITY)) {
      publishLog.textContent = 'Control server is outdated. Run Run-Even-Sim.cmd to refresh local services.';
    } else {
      publishLog.textContent = `Control server ready (${info.version ?? 'unknown'})`;
    }
  } catch {
    publishLog.textContent = 'Control server not reachable. Run Run-Even-Sim.cmd.';
  }

  try {
    const response = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as {
      config?: {
        git?: { deployed?: boolean };
        square?: { configured?: boolean; environment?: string; locationId?: string };
      };
    } | null;
    state.deployed = !!body?.config?.git?.deployed;

    // Pre-fill Square config form from saved values
    if (body?.config?.square?.locationId) {
      squareLocationInput.value = body.config.square.locationId;
    }
    if (body?.config?.square?.environment) {
      squareEnvSelect.value = body.config.square.environment;
    }
    if (body?.config?.square?.configured) {
      squareStatusText.textContent = 'Credentials saved. Polling...';
    }
  } catch {}

  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Even bridge timeout')), 5000)),
    ]);

    await createStartupPage();
    const handleHubEvent = (event: any) => {
      const eventType = extractEventType(event);
      let action = mapEventTypeToAction(eventType);

      if (!action && event?.textEvent && !event?.listEvent && !event?.sysEvent) {
        action = 'CLICK';
      }

      if (!action && shouldTreatEmptySysEventAsClick(event)) {
        action = 'CLICK';
      }

      const eventLabel = action ?? 'NONE';
      if (isDuplicateEvent(event, eventLabel)) {
        return;
      }
      appendEventLog(`${new Date().toLocaleTimeString()}  ${eventLabel}`);

      if (action) {
        lastResolvedAction = action;
        lastResolvedActionAt = Date.now();
        console.log('[hub-event]', { action, eventType, event });
        void applyAction(action);
      }
    };

    bridge.onEvenHubEvent((event) => {
      handleHubEvent(event);
    });

    window.addEventListener('evenHubEvent', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      handleHubEvent(detail);
    });
  } catch (error) {
    console.warn('Even bridge not ready, using browser fallback mode:', error);
  }

  // Start order polling (fetch from server every 5s)
  await pollOrders();
  window.setInterval(() => { void pollOrders(); }, 5000);
  // Re-render every second — advances wait times and not-here pan
  window.setInterval(() => { nhPanOffset++; void render(); }, 1000);

  await render();
}

void init();
