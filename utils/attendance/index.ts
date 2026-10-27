import type { AppBindingPlayer, Client } from 'skland-kit'
import type { AttendanceHandlerResult } from './types'
import { formatCharacterName } from '../format'
import { retry } from '../retry'
import { attendanceHandlerRegistry } from './registry'

export * from './registry'
export * from './shared'
// Export types and utility functions
export * from './types'

function getStatusMark(success: boolean): string {
  return success ? '✅' : '❌'
}

/**
 * 在消息中的角色标签前插入状态标记
 * 例如：【明日方舟】官服角色 xxx#1234 签到成功
 *   -> ✅【明日方舟】官服角色 xxx#1234 签到成功
 */
function withStatusMark(
  message: string,
  characterLabel: string,
  success: boolean,
): string {
  const mark = getStatusMark(success)
  if (message.includes(characterLabel)) {
    return message.replace(characterLabel, `${mark} ${characterLabel}`)
  }
  // 兜底：即使 handler 返回的消息不以角色标签开头，也保证有标记
  return `${mark} ${message}`
}

const ALREADY_ATTENDED_KEYWORDS = ['跳过签到', '已经签到']

function isAlreadyAttendedMessage(message: string): boolean {
  return ALREADY_ATTENDED_KEYWORDS.some(k => message.includes(k))
}

/**
 * Core attendance function
 */
async function attendance(
  client: Client,
  character: AppBindingPlayer,
  appName?: string,
): Promise<AttendanceHandlerResult> {
  const characterLabel = formatCharacterName(character, appName)

  // Find handler
  const handlerConfig = attendanceHandlerRegistry.get(character.gameId)

  if (!handlerConfig) {
    return {
      success: false,
      message: withStatusMark(
        `${characterLabel} 不支持的游戏 (gameId: ${character.gameId})`,
                              characterLabel,
                              false,
      ),
      hasError: true,
    }
  }

  // Validate character (if validation function exists)
  if (handlerConfig.validate) {
    const validation = handlerConfig.validate(character)
    if (!validation.valid) {
      return {
        success: false,
        message: withStatusMark(
          `${characterLabel} ${validation.reason || '验证失败'}，跳过签到`,
          characterLabel,
          false,
        ),
        hasError: false,
      }
    }
  }

  // Execute attendance
  const result = await handlerConfig.handler({
    client,
    character,
    characterLabel,
  })

  // 已签到也算成功：修正 success / hasError，并渲染 ✅
  const alreadyAttended = isAlreadyAttendedMessage(result.message)
  const isSuccess = result.success || alreadyAttended
  const hasError = alreadyAttended ? false : result.hasError

  return {
    ...result,
    success: isSuccess,
    hasError,
    message: withStatusMark(result.message, characterLabel, isSuccess),
  }
}

/**
 * Attendance function with retry (backward compatible API)
 */
export async function attendCharacter(
  client: Client,
  character: AppBindingPlayer,
  maxRetries: number,
  appName?: string,
  onRetry?: (retriesLeft: number) => void,
): Promise<AttendanceHandlerResult> {
  const characterLabel = formatCharacterName(character, appName)

  try {
    return await retry(() => attendance(client, character, appName), {
      retries: maxRetries,
      onRetry: onRetry ? retriesLeft => onRetry(retriesLeft) : undefined,
    })
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message: withStatusMark(
        `${characterLabel} 签到过程中出现未知错误: ${errorMessage}`,
        characterLabel,
        false,
      ),
      hasError: true,
    }
  }
}

// Export AttendanceResult type alias for backward compatibility
export type { AttendanceHandlerResult as AttendanceResult }
