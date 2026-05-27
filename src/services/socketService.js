// src/services/socketService.js
// ─────────────────────────────────────────────────────────────────────────────
//  SOCKET SERVICE — Real-time lead push notifications
//
//  FIX 1: BASE_URL in config.js includes /api suffix (needed for axios).
//  Socket.IO must connect to the root URL — not /api.
//  Strip /api before passing to io().
//
//  FIX 2: Render's reverse proxy does not reliably upgrade WebSocket on the
//  first attempt — the connection hangs for minutes then dies. Using
//  ['websocket', 'polling'] lets Socket.IO start on polling, upgrade to
//  WebSocket when the proxy allows it, and fall back to polling if not.
//  This is the standard approach for cloud-hosted Socket.IO servers.
// ─────────────────────────────────────────────────────────────────────────────

import { io }       from 'socket.io-client';
import { BASE_URL } from '../config/config';
import { fetchLeads } from '../store/slices/leadsSlice';
import { showNewLeadNotification, showReassignedLeadNotification } from './notificationService';

// Strip /api suffix — Socket.IO connects to root, not /api
const SOCKET_URL = BASE_URL.replace(/\/api\/?$/, '');

let socket    = null;
let _userId   = null;
let _dispatch = null;

// ─────────────────────────────────────────────────────────────────────────────
//  connectSocket(userId, dispatch)
// ─────────────────────────────────────────────────────────────────────────────
export function connectSocket(userId, dispatch) {
  _userId   = userId;
  _dispatch = dispatch;

  // Already connected — just make sure we're in the right room
  if (socket?.connected) {
    socket.emit('agent_join', { userId });
    return;
  }

  // Reconnect an existing (disconnected) socket
  if (socket) {
    socket.connect();
    return;
  }

  console.log('[Socket] Connecting to:', SOCKET_URL);

  socket = io(SOCKET_URL, {
    // FIX 2: Allow polling as fallback — Render's proxy can't always upgrade
    // WebSocket on the first try. Socket.IO will start on polling and
    // automatically upgrade to WebSocket once the connection is established.
    // Previously ['websocket'] only caused the connection to hang for ~10 min
    // then die, meaning the agent never joined their room and never received
    // real-time lead notifications.
    transports:           ['websocket', 'polling'],
    reconnection:         true,
    reconnectionDelay:    2000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
    timeout:              10000,
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  socket.on('connect', () => {
    console.log('[Socket] ✅ Connected:', socket.id, '| transport:', socket.io.engine.transport.name);
    socket.emit('agent_join', { userId: _userId });
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.warn('[Socket] ❌ Connection error:', err.message, '| URL:', SOCKET_URL);
  });

  // Log when transport upgrades from polling → websocket
  socket.io.on('upgrade', (transport) => {
    console.log('[Socket] ⬆️  Transport upgraded to:', transport.name);
  });

  // ── NEW LEAD ASSIGNED ─────────────────────────────────────────────────────
  socket.on('new_lead_assigned', async (payload) => {
    console.log('[Socket] 🆕 new_lead_assigned:', payload);
    try {
      if (_dispatch) {
        await _dispatch(fetchLeads());
      }
      if (payload?.leadName) {
        if (payload.eventType === 'reassigned') {
          await showReassignedLeadNotification({
            leadId:   payload.leadId   || '',
            leadName: payload.leadName || 'Lead',
          });
        } else {
          await showNewLeadNotification({
            leadId:   payload.leadId   || '',
            leadName: payload.leadName || 'New Lead',
            source:   payload.source   || '',
          });
        }
      }
    } catch (err) {
      console.warn('[Socket] new_lead_assigned handler error:', err.message);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  disconnectSocket()
// ─────────────────────────────────────────────────────────────────────────────
export function disconnectSocket() {
  if (socket) {
    socket.off('new_lead_assigned');
    socket.off('connect');
    socket.off('disconnect');
    socket.off('connect_error');
    socket.disconnect();
    socket    = null;
    _userId   = null;
    _dispatch = null;
    console.log('[Socket] Disconnected and cleaned up');
  }
}

export function getSocket() {
  return socket;
}