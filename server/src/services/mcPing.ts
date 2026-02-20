import * as net from 'net';

export interface McPingResult {
  motd: string;
  onlinePlayers: number;
  maxPlayers: number;
  version: string;
}

// ─── VarInt helpers ──────────────────────────────────────────────────────

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0; // treat as unsigned
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function readVarInt(buf: Buffer, offset: number): { value: number; bytesRead: number } | null {
  let result = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buf.length) {
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) {
      return { value: result, bytesRead: pos - offset };
    }
    shift += 7;
    if (shift >= 35) return null; // VarInt too large
  }

  return null; // incomplete
}

// ─── Packet building ────────────────────────────────────────────────────

function encodeString(str: string): Buffer {
  const utf8 = Buffer.from(str, 'utf-8');
  return Buffer.concat([writeVarInt(utf8.length), utf8]);
}

function buildPacket(packetId: number, ...payloads: Buffer[]): Buffer {
  const idBuf = writeVarInt(packetId);
  const body = Buffer.concat([idBuf, ...payloads]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

// ─── MOTD text extraction ───────────────────────────────────────────────

function stripColorCodes(text: string): string {
  return text.replace(/\u00A7./g, '');
}

function extractMotdText(description: unknown): string {
  if (typeof description === 'string') {
    return stripColorCodes(description);
  }

  if (typeof description === 'object' && description !== null) {
    const obj = description as Record<string, unknown>;
    let result = typeof obj.text === 'string' ? obj.text : '';

    if (Array.isArray(obj.extra)) {
      for (const part of obj.extra) {
        result += extractMotdText(part);
      }
    }

    return stripColorCodes(result);
  }

  return '';
}

// ─── MC SLP protocol ────────────────────────────────────────────────────

/**
 * Perform a Minecraft Java Edition Server List Ping (SLP).
 *
 * Connects via TCP, sends Handshake + Status Request,
 * and parses the JSON status response.
 *
 * @param host - Server hostname or IP
 * @param port - Server port
 * @param timeoutMs - Connection/read timeout (default 5000ms)
 */
export function mcPing(host: string, port: number, timeoutMs: number = 5000): Promise<McPingResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBuffer = Buffer.alloc(0);

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const succeed = (result: McPingResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.on('connect', () => {
      // Build and send Handshake packet (id=0x00)
      const protocolVersion = writeVarInt(0xffffffff); // -1 as unsigned VarInt
      const serverAddr = encodeString(host);
      const serverPort = Buffer.alloc(2);
      serverPort.writeUInt16BE(port, 0);
      const nextState = writeVarInt(1); // Status

      const handshake = buildPacket(0x00, protocolVersion, serverAddr, serverPort, nextState);
      socket.write(handshake);

      // Send Status Request packet (id=0x00, no payload)
      const statusRequest = buildPacket(0x00);
      socket.write(statusRequest);
    });

    socket.on('data', (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      tryParse();
    });

    socket.on('timeout', () => {
      fail(new Error('Connection timed out'));
    });

    socket.on('error', (err: Error) => {
      fail(err);
    });

    socket.on('close', () => {
      if (!settled) {
        fail(new Error('Connection closed before response'));
      }
    });

    function tryParse(): void {
      // Read packet length (VarInt)
      const packetLen = readVarInt(responseBuffer, 0);
      if (!packetLen) return; // incomplete

      const totalLen = packetLen.bytesRead + packetLen.value;
      if (responseBuffer.length < totalLen) return; // incomplete

      let offset = packetLen.bytesRead;

      // Read packet ID (VarInt)
      const packetId = readVarInt(responseBuffer, offset);
      if (!packetId) {
        fail(new Error('Failed to read packet ID'));
        return;
      }
      offset += packetId.bytesRead;

      if (packetId.value !== 0x00) {
        fail(new Error(`Unexpected packet ID: 0x${packetId.value.toString(16)}`));
        return;
      }

      // Read JSON string length (VarInt)
      const strLen = readVarInt(responseBuffer, offset);
      if (!strLen) {
        fail(new Error('Failed to read string length'));
        return;
      }
      offset += strLen.bytesRead;

      if (responseBuffer.length < offset + strLen.value) return; // incomplete

      const jsonStr = responseBuffer.subarray(offset, offset + strLen.value).toString('utf-8');

      let status: any;
      try {
        status = JSON.parse(jsonStr);
      } catch {
        fail(new Error('Failed to parse status JSON'));
        return;
      }

      const motd = extractMotdText(status.description);
      const onlinePlayers = status.players?.online ?? 0;
      const maxPlayers = status.players?.max ?? 0;
      const version = status.version?.name ?? 'unknown';

      succeed({ motd, onlinePlayers, maxPlayers, version });
    }
  });
}
