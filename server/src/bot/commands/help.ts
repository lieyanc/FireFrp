/**
 * Help command handler.
 * Returns the help text for the bot.
 */

export function handleHelp(): string {
  return [
    '--- FireFrp 帮助 ---',
    '',
    '命令列表:',
    '  开服 [游戏类型] [时长(分钟)]',
    '    创建一个临时隧道，获取 access key',
    '    游戏类型: minecraft / mc / terraria 等',
    '    时长默认 60 分钟，最大 480 分钟',
    '    示例: @Bot 开服 mc',
    '    示例: @Bot 开服 mc 120',
    '',
    '  状态',
    '    查看你当前活跃的隧道列表',
    '    示例: @Bot 状态',
    '',
    '  帮助',
    '    显示本帮助信息',
    '',
    '使用方式:',
    '  1. 在群里 @Bot 开服 获取 key',
    '  2. 在本地运行 FireFrp 客户端',
    '  3. 输入 key 和本地端口即可建立隧道',
    '',
    '限制:',
    '  每用户最多 3 个同时活跃的 key',
    '  每群每小时最多 10 次开服请求',
  ].join('\n');
}
