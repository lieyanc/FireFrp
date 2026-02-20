/**
 * Help command handler.
 * Returns the help text for the bot.
 */

import { getDisplayVersion, getMessageHeader } from '../../version';
import { config } from '../../config';

export function handleHelp(): string {
  const maxTtl = config.keyTtlMinutes;
  return [
    `--- ${getMessageHeader()} | 帮助 ---`,
    '',
    '命令列表:',
    '  开服 [游戏类型] [时长(分钟)]',
    '    创建一个临时隧道，获取 access key',
    '    游戏类型: minecraft / mc / terraria 等',
    `    时长默认 ${maxTtl} 分钟，最大 ${maxTtl} 分钟`,
    '    示例: @Bot 开服 mc',
    '    示例: @Bot 开服 mc 120',
    '',
    '  状态',
    '    查看你当前活跃的隧道列表',
    '',
    '  列表',
    '    查看本群所有隧道 (MC 服务器会显示 MOTD)',
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
    '',
    '管理员命令 (仅管理员可用):',
    '  隧道列表  查看所有活跃隧道',
    '  踢掉 <隧道ID>  撤销指定隧道',
    '  服务器  查看服务器详细状态',
    '  群列表  查看群白名单',
    '  加群 <群号>  添加群白名单',
    '  移群 <群号>  移除群白名单',
  ].join('\n');
}
