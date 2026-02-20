import WebSocket from 'ws';
import { config } from '../config';
import { logger } from '../utils/logger';
import { parseCommand, extractTextAfterAt, type MessageSegment } from './messageParser';
import { handleHelp } from './commands/help';
import { handleOpenServer } from './commands/openServer';
import { handleStatus } from './commands/status';

const log = logger.child({ module: 'qqBot' });

export interface BotMessage {
  userId: string;
  userName: string;
  groupId: string;
  content: string;
}

interface PendingCall {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Process an incoming bot message and return a response string.
 * This is the core dispatch logic, independent of the transport layer.
 */
export function processMessage(msg: BotMessage): string | null {
  const parsed = parseCommand(msg.content);

  if (!parsed) {
    return null; // Not a recognized command
  }

  switch (parsed.command) {
    case 'help':
      return handleHelp();

    case 'open':
      return handleOpenServer(msg.userId, msg.userName, msg.groupId, parsed.args);

    case 'status':
      return handleStatus(msg.userId);

    default:
      return '未知命令，输入"帮助"查看可用命令。';
  }
}

const API_CALL_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * QQ Bot client using OneBot 11 Forward WebSocket.
 * Connects to NapCatQQ's WebSocket Server to receive events and send API calls.
 */
class QQBot {
  private ws: WebSocket | null = null;
  private running: boolean = false;
  private selfId: number = 0;
  private echoCounter: number = 0;
  private pendingCalls: Map<string, PendingCall> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt: number = 0;

  /**
   * Start the QQ Bot.
   * Connects to NapCat WebSocket Server via OneBot 11 protocol.
   */
  async start(): Promise<void> {
    if (!config.bot.wsUrl) {
      log.warn('Bot wsUrl not configured, skipping bot startup');
      return;
    }

    this.selfId = config.bot.selfId;
    this.running = true;

    log.info({ wsUrl: config.bot.wsUrl, selfId: this.selfId }, 'Starting QQ Bot (OneBot 11)');

    this.connect();
  }

  /**
   * Establish WebSocket connection to NapCat.
   */
  private connect(): void {
    if (!this.running) return;

    // Build WS URL with optional access_token
    let wsUrl = config.bot.wsUrl;
    if (config.bot.token) {
      const separator = wsUrl.includes('?') ? '&' : '?';
      wsUrl = `${wsUrl}${separator}access_token=${config.bot.token}`;
    }

    log.info({ url: config.bot.wsUrl }, 'Connecting to NapCat WebSocket');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      log.error({ err }, 'Failed to create WebSocket');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      log.info('Connected to NapCat WebSocket');
      this.reconnectAttempt = 0;
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(data.toString());
        this.handleIncoming(parsed);
      } catch (err) {
        log.error({ err }, 'Failed to parse WebSocket message');
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket connection closed');
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.error({ err: err.message }, 'WebSocket error');
      // 'close' event will fire after this, triggering reconnect
    });
  }

  /**
   * Handle an incoming JSON message from NapCat.
   * Could be an event push or an API response.
   */
  private handleIncoming(data: any): void {
    // API response: has 'echo' field matching a pending call
    if (data.echo && this.pendingCalls.has(data.echo)) {
      const pending = this.pendingCalls.get(data.echo)!;
      this.pendingCalls.delete(data.echo);
      clearTimeout(pending.timer);

      if (data.status === 'ok') {
        pending.resolve(data.data);
      } else {
        pending.reject(new Error(`API call failed: status=${data.status} retcode=${data.retcode}`));
      }
      return;
    }

    // Event push
    if (data.post_type) {
      this.handleEvent(data);
    }
  }

  /**
   * Handle an OneBot 11 event.
   */
  private handleEvent(event: any): void {
    switch (event.post_type) {
      case 'message':
        this.handleMessageEvent(event);
        break;

      case 'meta_event':
        this.handleMetaEvent(event);
        break;

      default:
        log.debug({ postType: event.post_type }, 'Ignoring event');
        break;
    }
  }

  /**
   * Handle a message event.
   */
  private handleMessageEvent(event: any): void {
    // Only handle group messages
    if (event.message_type !== 'group') return;

    const segments: MessageSegment[] = event.message;
    if (!Array.isArray(segments)) return;

    // Auto-detect selfId from the first message if not configured
    if (!this.selfId && event.self_id) {
      this.selfId = event.self_id;
      log.info({ selfId: this.selfId }, 'Auto-detected bot self_id');
    }

    // Extract text after @Bot mention
    const text = extractTextAfterAt(segments, this.selfId);
    if (!text) return;

    const groupId = event.group_id;
    const userId = event.user_id;
    const sender = event.sender || {};

    const msg: BotMessage = {
      userId: String(userId),
      userName: sender.card || sender.nickname || String(userId),
      groupId: String(groupId),
      content: text,
    };

    log.info(
      { userId: msg.userId, groupId: msg.groupId, content: msg.content },
      'Processing bot command',
    );

    const reply = processMessage(msg);
    if (reply) {
      this.sendGroupMessage(groupId, userId, reply).catch((err) => {
        log.error({ err, groupId }, 'Failed to send group message');
      });
    }
  }

  /**
   * Handle a meta event (heartbeat, lifecycle).
   */
  private handleMetaEvent(event: any): void {
    if (event.meta_event_type === 'heartbeat') {
      log.debug('Heartbeat received');
    } else if (event.meta_event_type === 'lifecycle') {
      log.info({ subType: event.sub_type }, 'Lifecycle event');
      // On 'connect' lifecycle, auto-detect selfId
      if (event.self_id && !this.selfId) {
        this.selfId = event.self_id;
        log.info({ selfId: this.selfId }, 'Self ID from lifecycle event');
      }
    }
  }

  /**
   * Call an OneBot 11 API via WebSocket.
   * Uses echo field to correlate request/response.
   */
  private callApi(action: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const echo = `firefrp_${++this.echoCounter}`;

      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`API call '${action}' timed out`));
      }, API_CALL_TIMEOUT_MS);

      this.pendingCalls.set(echo, { resolve, reject, timer });

      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /**
   * Send a group message, mentioning the user.
   */
  async sendGroupMessage(groupId: number, userId: number, text: string): Promise<void> {
    const message: MessageSegment[] = [
      { type: 'at', data: { qq: String(userId) } },
      { type: 'text', data: { text: ' ' + text } },
    ];

    await this.callApi('send_group_msg', {
      group_id: groupId,
      message,
    });

    log.debug({ groupId, userId }, 'Group message sent');
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (!this.running) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt++;

    log.info({ delay, attempt: this.reconnectAttempt }, 'Scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Stop the QQ Bot gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    log.info('Stopping QQ Bot');
    this.running = false;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending API calls
    for (const [echo, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bot shutting down'));
    }
    this.pendingCalls.clear();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    log.info('QQ Bot stopped');
  }

  /**
   * Check if the bot is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

// Singleton instance
export const qqBot = new QQBot();
