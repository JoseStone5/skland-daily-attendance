import type { AppBindingPlayer, Client } from 'skland-kit'
import type { AttendanceHandlerResult } from './types'
import { formatCharacterName } from '../format'
import { retry } from '../retry'
import { attendanceHandlerRegistry } from './registry'

export * from './registry'
export * from './shared'
// Export types and utility functions
export * from './types'

const ALREADY_ATTENDED_KEYWORDS = ['已签到', '今日已签到', '已经签到']

function isAlreadyAttendedMessage(message: string): boolean {
  return ALREADY_ATTENDED_KEYWORDS.some(k => message.includes(k))
}

const NO_CHARACTER_KEYWORDS = ['没有角色']

function isNoCharacterMessage(message: string): boolean {
  return NO_CHARACTER_KEYWORDS.some(k => message.includes(k))
}

/**
 * 已签到 或 成功 -> ✅，其余 -> ❌
 */
function getStatusMark(success: boolean, alreadyAttended: boolean): string {
  return success || alreadyAttended ? '✅' : '❌'
}

function withStatusMark(
  message: string,
  characterLabel: string,
  success: boolean,
  alreadyAttended: boolean,
): string {
  const mark = getStatusMark(success, alreadyAttended)
  if (message.includes(characterLabel)) {
    return message.replace(characterLabel, `${mark} ${characterLabel}`)
  }
  return `${mark} ${message}`
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
                              false,
      ),
      hasError: true,
    }
  }

  // Validate character (if validation function exists)
  if (handlerConfig.validate) {
    const validation = handlerConfig.validate(character)
      if (!validation.valid) {
      const reason = validation.reason || '验证失败'
      // 没有角色：不显示这一行，也不计入统计
      if (isNoCharacterMessage(reason)) {
        return { success: false, message: '', hasError: false, skipped: true }
      }
      return {
        success: false,
        message: withStatusMark(
          `${characterLabel} ${reason}，跳过签到`,
          characterLabel,
          false,
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

  // 没有角色：不显示这一行（返回空消息，由 message collector 过滤）
  if (isNoCharacterMessage(result.message)) {
    return {
      ...result,
      message: '',
      skipped: true,
    }
  }

  // 已签到：显示 ✅，但 success / hasError 保持 handler 原值，
  // 以免影响 tasks/attendance.ts 里的摘要统计
  const alreadyAttended = isAlreadyAttendedMessage(result.message)

  return {
    ...result,
    message: withStatusMark(result.message, characterLabel, result.success, alreadyAttended),
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
        false,
      ),
      hasError: true,
    }
  }
}

// Export AttendanceResult type alias for backward compatibility
export type { AttendanceHandlerResult as AttendanceResult }
