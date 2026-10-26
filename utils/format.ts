import type { AppBindingPlayer } from 'skland-kit'

/**
 * Format game name from appCode
 */
export function formatGameName(appCode: string): string {
  const gameNameMap: Record<string, string> = {
    arknights: '明日方舟',
    endfield: '终末地',
  }
  return gameNameMap[appCode] || appCode
}

export function formatCharacterName(character: AppBindingPlayer, appName?: string) {
  const gamePrefix = appName ? `【${appName}】` : ''
  return `${gamePrefix}${character.channelName}角色 ${formatPrivacyName(character)}`
}

export function formatPrivacyName(character: AppBindingPlayer) {
  // 终末地的昵称和等级从 defaultRole 获取
  if (character.gameId === 3) {
    const nickname = character.defaultRole?.nickname || ''
    return `${nickname} lv.${character.defaultRole?.level || 0}`
  }

  const [name, number] = character.nickName.split('#')
  if (!name)
    throw new Error('Unexpected Error: 明日方舟 nickName 格式不正确')

  return `${name}#${number}`
}
