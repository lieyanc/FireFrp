/**
 * QQ Bot message command parser.
 * Handles OneBot 11 message segment arrays and command parsing.
 */

export interface ParsedCommand {
  command: string;
  args: string[];
  raw: string;
}

/** OneBot 11 message segment. */
export interface MessageSegment {
  type: string;
  data: Record<string, string>;
}

/**
 * Known command aliases.
 */
const COMMAND_ALIASES: Record<string, string> = {
  '开服': 'open',
  'open': 'open',
  '状态': 'status',
  'status': 'status',
  '帮助': 'help',
  'help': 'help',
  // Admin commands
  '隧道列表': 'tunnels',
  'tunnels': 'tunnels',
  '踢掉': 'kick',
  'kick': 'kick',
  '加群': 'addgroup',
  'addgroup': 'addgroup',
  '移群': 'rmgroup',
  'rmgroup': 'rmgroup',
  '群列表': 'groups',
  'groups': 'groups',
  '服务器': 'server',
  'server': 'server',
};

/**
 * Extract text content from OneBot 11 message segments after the @Bot mention.
 *
 * Scans through message segments, finds the `at` segment targeting selfId,
 * then concatenates all subsequent `text` segments.
 *
 * @param segments - OneBot 11 message segment array
 * @param selfId - The bot's own QQ number
 * @returns The extracted text content, or null if the bot is not mentioned
 */
export function extractTextAfterAt(segments: MessageSegment[], selfId: number): string | null {
  const selfIdStr = String(selfId);
  let foundAt = false;

  const textParts: string[] = [];

  for (const seg of segments) {
    if (!foundAt) {
      if (seg.type === 'at' && seg.data.qq === selfIdStr) {
        foundAt = true;
      }
      continue;
    }
    // After the @Bot mention, collect text segments
    if (seg.type === 'text') {
      textParts.push(seg.data.text);
    }
  }

  if (!foundAt) return null;

  const text = textParts.join('').trim();
  return text || null;
}

/**
 * Parse a message text into a structured command.
 *
 * Expected format after @Bot mention is stripped:
 *   "开服 Minecraft 120"
 *   "状态"
 *   "帮助"
 *
 * @param text - The raw message text (with @Bot mention already stripped)
 * @returns ParsedCommand or null if the text is not a valid command
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const rawCommand = parts[0].toLowerCase();
  const command = COMMAND_ALIASES[rawCommand] ?? COMMAND_ALIASES[parts[0]] ?? null;

  if (!command) {
    return null;
  }

  return {
    command,
    args: parts.slice(1),
    raw: trimmed,
  };
}
