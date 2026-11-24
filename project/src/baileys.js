/**
 * baileys.js
 * Gestiona múltiples sesiones de WhatsApp usando @whiskeysockets/baileys.
 * Cada sesión tiene su propia carpeta auth/<sessionId> y su propio socket.
 */

import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fse from 'fs-extra';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import { sleep } from './utils.js';

const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
const processStart = Date.now();

function disconnectInfo(lastDisconnect) {
  const err = lastDisconnect?.error;
  const boom = err instanceof Boom ? err : null;
  const payload = boom?.output?.payload || {};
  return {
    err: err?.message || null,
    statusCode: boom?.output?.statusCode ?? null,
    reason: payload.reason || payload.message || null,
    payloadCode: payload.code ?? null,
    when: lastDisconnect?.when ? new Date(lastDisconnect.when).toISOString() : null,
  };
}

/**
 * sessions: Map<sessionId, SessionState>
 * SessionState: { sock, isConnected, qrDataUrl, reconnectAttempts, waiters }
 */
const sessions = new Map();

function authPath(sessionId) {
  return path.join(config.paths.auth, sessionId);
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    connected: s.isConnected,
    hasQr: !!s.qrDataUrl,
    reconnectAttempts: s.reconnectAttempts,
  }));
}

export function getFirstConnectedSession() {
  for (const [id, s] of sessions.entries()) {
    if (s.isConnected) return id;
  }
  return null;
}

/**
 * Crea una nueva sesión o retorna la existente.
 * @param {string} sessionId
 */
export async function createSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const s = {
    sock: null,
    isConnected: false,
    qrDataUrl: null,
    reconnectAttempts: 0,
    waiters: new Set(),
  };
  sessions.set(sessionId, s);
  await connect(sessionId);
  return s;
}

/**
 * Elimina una sesión: cierra el socket y borra la carpeta auth/<sessionId>.
 * @param {string} sessionId
 */
export async function deleteSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    try { s.sock?.end(); } catch {}
    sessions.delete(sessionId);
  }
  await fse.remove(authPath(sessionId));
  logger.info({ sessionId }, 'Sesión eliminada');
}

/**
 * Carga las sesiones existentes en auth/ al arrancar el proceso.
 */
export async function loadExistingSessions() {
  await fse.ensureDir(config.paths.auth);
  const entries = await fse.readdir(config.paths.auth, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  if (dirs.length === 0) {
    logger.error({
      event: 'auth_dir_empty',
      authDir: config.paths.auth,
      entries: entries.map((e) => e.name),
      uptimeMs: Date.now() - processStart,
    }, 'No hay sesiones previas. Revisá el montaje EFS: Creá una en GET /sessions/:id/qr');
    return;
  }

  logger.info({ sessions: dirs }, 'Cargando sesiones existentes...');
  for (const id of dirs) {
    await createSession(id);
  }
}

async function connect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;

  // Cerrar socket anterior si existe para evitar conexiones duplicadas
  if (s.sock) {
    try { s.sock.end(); } catch {}
    s.sock = null;
  }

  const ap = authPath(sessionId);
  await fse.ensureDir(ap);

  const { state, saveCreds } = await useMultiFileAuthState(ap);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({
    event: 'baileys_start',
    sessionId,
    version,
    authDir: ap,
    authenticated: !!state.creds?.me,
    uptimeMs: Date.now() - processStart,
  }, 'Iniciando Baileys');

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Chrome', '124.0.6367.207'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 500,
  });

  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ws?.on?.('close', (code, reason) => {
    logger.warn({
      event: 'ws_close_frame',
      sessionId,
      code,
      reason: reason?.toString?.() || null,
      uptimeMs: Date.now() - processStart,
    }, 'WebSocket cerrado por el par');
  });

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      if (!u.update?.status) continue;
      const status = { 2: 'enviado', 3: 'entregado', 4: 'leído' }[u.update.status];
      if (status) logger.info({ sessionId, jid: u.key.remoteJid, status }, `📬 Mensaje ${status}`);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      s.qrDataUrl = await QRCode.toDataURL(qr);
      logger.info({ sessionId }, `⚡ QR listo — abrí /sessions/${sessionId}/qr en el navegador`);
    }

    if (connection === 'connecting') {
      logger.info({
        event: 'whatsapp_connecting',
        sessionId,
        reconnectAttempts: s.reconnectAttempts,
        uptimeMs: Date.now() - processStart,
      }, 'Conectando a WhatsApp...');
    }

    if (connection === 'open') {
      s.isConnected = true;
      s.qrDataUrl = null;
      s.reconnectAttempts = 0;
      logger.info({
        event: 'whatsapp_connected',
        sessionId,
        phone: s.sock?.user?.id?.split(':')[0].split('@')[0] || null,
        uptimeMs: Date.now() - processStart,
      }, '✅ WhatsApp conectado');
      for (const resolve of s.waiters) resolve();
      s.waiters.clear();
    }

    if (connection === 'close') {
      s.isConnected = false;
      const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : null;
      const statusCode = boom?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({
        event: 'whatsapp_disconnected',
        sessionId,
        connection,
        shouldReconnect,
        reconnectAttempts: s.reconnectAttempts,
        uptimeMs: Date.now() - processStart,
        ...disconnectInfo(lastDisconnect),
      }, 'Conexión cerrada');

      if (shouldReconnect) {
        await handleReconnect(sessionId);
      } else {
        logger.warn({ sessionId }, 'Logged out. Borrando auth y mostrando nuevo QR...');
        s.qrDataUrl = null;
        s.reconnectAttempts = 0;
        await fse.emptyDir(ap);
        // Esperar antes de reconectar para no ser detectado como bot
        await sleep(8000);
        await connect(sessionId);
      }
    }
  });
}

async function handleReconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.reconnectAttempts++;

  if (s.reconnectAttempts > config.reconnect.maxAttempts) {
    logger.error({ sessionId }, 'Máximo de reintentos superado. Sesión eliminada.');
    sessions.delete(sessionId);
    return;
  }

  const delay = Math.min(
    config.reconnect.delayMs * Math.pow(2, s.reconnectAttempts - 1),
    60_000
  );

  logger.info({ sessionId, attempt: s.reconnectAttempts, delayMs: delay }, 'Reconectando...');
  await sleep(delay);
  await connect(sessionId);
}

// ─── Envío ───────────────────────────────────────────────────────────────────

const WAIT_CONNECT_MS = parseInt(process.env.WAIT_CONNECT_MS || '90000', 10);

/**
 * Espera a que la sesión termine de reconectarse antes de enviar.
 * Si la sesión no existe en este proceso (auth vacío), falla de inmediato.
 */
function waitForConnection(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    throw new Error(`Sesión "${sessionId}" no cargada en este proceso — generá el QR con GET /sessions/${sessionId}/qr`);
  }
  if (s.isConnected) return Promise.resolve();

  logger.warn({
    event: 'send_waiting_connection',
    sessionId,
    reconnectAttempts: s.reconnectAttempts,
    timeoutMs: WAIT_CONNECT_MS,
  }, 'Sesión desconectada — esperando reconexión antes de enviar');

  return new Promise((resolve, reject) => {
    const waiter = () => {
      clearTimeout(timer);
      s.waiters.delete(waiter);
      resolve();
    };
    const timer = setTimeout(() => {
      s.waiters.delete(waiter);
      reject(new Error(`Sesión "${sessionId}" sigue desconectada tras ${WAIT_CONNECT_MS / 1000}s (intentos: ${s.reconnectAttempts})`));
    }, WAIT_CONNECT_MS);
    s.waiters.add(waiter);
  });
}

export async function sendDocumentVia(sessionId, jid, fileBuffer, filename, caption) {
  await waitForConnection(sessionId);
  const s = sessions.get(sessionId);
  logger.info({ sessionId, jid, filename }, 'Enviando documento');
  const result = await s.sock.sendMessage(jid, {
    document: fileBuffer,
    mimetype: 'application/pdf',
    fileName: filename,
    caption,
  });
  logger.info({ sessionId, jid, msgId: result?.key?.id, status: result?.status }, '✅ Documento enviado');
}

export async function sendImageVia(sessionId, jid, imageBuffer, mimetype, caption) {
  await waitForConnection(sessionId);
  const s = sessions.get(sessionId);
  logger.info({ sessionId, jid, mimetype }, 'Enviando imagen');
  const result = await s.sock.sendMessage(jid, { image: imageBuffer, mimetype, caption });
  logger.info({ sessionId, jid, msgId: result?.key?.id, status: result?.status }, '✅ Imagen enviada');
}

export async function sendTextVia(sessionId, jid, text) {
  await waitForConnection(sessionId);
  const s = sessions.get(sessionId);
  logger.info({ sessionId, jid }, 'Enviando texto');
  const result = await s.sock.sendMessage(jid, { text });
  logger.info({ sessionId, jid, msgId: result?.key?.id, status: result?.status }, '✅ Texto enviado');
}

export async function listGroupsVia(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) {
    logger.warn({ sessionId }, 'No conectado. No se pueden listar grupos.');
    return [];
  }
  const groups = await s.sock.groupFetchAllParticipating();
  return Object.values(groups).map((g) => ({
    id: g.id,
    name: g.subject,
    participants: g.participants?.length || 0,
  }));
}
