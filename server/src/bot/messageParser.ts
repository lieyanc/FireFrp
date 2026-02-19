/**
 * QQ Bot message command parser.
 * Parses command text after @Bot mention.
 */

export interface ParsedCommand {
  command: string;
  args: string[];
  raw: string;
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
};

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
