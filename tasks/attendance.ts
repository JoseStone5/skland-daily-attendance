import type { Storage } from 'unstorage'
import type { MessageCollector } from '~/utils/index'
import { AsyncLocalStorage } from 'node:async_hooks'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { useStorage } from 'nitro/storage'
import { defineTask } from 'nitro/task'
import { createClient } from 'skland-kit'
import { createContext } from 'unctx'
import { attendCharacter, createMessageCollector, generateAttendanceKey, getSplitByComma, retry } from '~/utils/index'

interface GameStats {
  gameName: string
  total: number
  succeeded: number
  alreadyAttended: number
  failed: number
}

interface ExecutionStats {
  accounts: {
    total: number
    successful: number
    skipped: number
    failed: number
    failedIndexes: number[]
  }
  charactersByGame: Map<number, GameStats>
}

interface ProcessAccountResult {
  accountHasError: boolean
  charactersCount: number
}

interface AttendanceContext {
  stats: ExecutionStats
  messageCollector: MessageCollector
  storage: Storage
  maxRetries: number
  totalAccounts: number
}

const attendanceContext = createContext<AttendanceContext>({
  asyncContext: true,
  AsyncLocalStorage,
})

const useAttendanceContext = attendanceContext.use
const ATTENDANCE_AVAILABLE_APPCODE = ['arknights', 'endfield']

async function processAccount(
  token: string,
  accountNumber: number,
): Promise<ProcessAccountResult> {
  const { stats, messageCollector, storage, maxRetries, totalAccounts } = useAttendanceContext()
  const attendanceKey = await generateAttendanceKey(token)
  const hasAttended = await storage.getItem(attendanceKey)

  messageCollector.notify(`账号 ${accountNumber}/${totalAccounts}`)

  if (hasAttended) {
    messageCollector.info('账号今日已完成签到，跳过')
    stats.accounts.skipped++
    return { accountHasError: false, charactersCount: 0 }
  }

  const client = createClient()
  const { list } = await retry(async () => {
    const { code } = await client.collections.hypergryph.grantAuthorizeCode(token)
    await client.signIn(code)
    return client.collections.player.getBinding()
  }, {
    retries: maxRetries,
    delay: 3000,
    onRetry: retriesLeft => messageCollector.log(`登录重试中，剩余次数：${retriesLeft}`),
  })
  const characterList = list
    .filter(i => ATTENDANCE_AVAILABLE_APPCODE.includes(i.appCode))
    .flatMap((binding) => {
      if (binding.appCode === 'endfield') {
        return binding.bindingList.flatMap(player =>
          player.roles.length > 0
            ? player.roles.map(role => ({ ...player, defaultRole: role, roles: [role] }))
            : [player],
        )
      }
      return binding.bindingList
    })

  let accountHasError = false
  let validCharactersCount = 0

  for (const character of characterList) {
    const result = await attendCharacter(
      client,
      character,
      maxRetries,
      character.gameName,
      retriesLeft => messageCollector.log(`重试中，剩余次数：${retriesLeft}`),
    )

    // 没有角色：不显示、不统计
    if (result.skipped)
      continue

    validCharactersCount++

    if (!stats.charactersByGame.has(character.gameId)) {
      stats.charactersByGame.set(character.gameId, {
        gameName: character.gameName,
        total: 0,
        succeeded: 0,
        alreadyAttended: 0,
        failed: 0,
      })
    }

    const gameStats = stats.charactersByGame.get(character.gameId)!
    gameStats.total++

    if (result.hasError) {
      messageCollector.infoError(result.message)
      gameStats.failed++
      accountHasError = true
    }
    else {
      messageCollector.info(result.message)
      if (result.success) {
        gameStats.succeeded++
      }
      else {
        gameStats.alreadyAttended++
      }
    }
  }

  if (!accountHasError) {
    await storage.setItem(attendanceKey, true)
    stats.accounts.successful++
  }
  else {
    stats.accounts.failed++
    stats.accounts.failedIndexes.push(accountNumber)
  }

  return { accountHasError, charactersCount: validCharactersCount }
}

export default defineTask<'success' | 'failed'>({
  meta: {
    name: 'attendance',
    description: '每日签到',
  },

  async run() {
    const config = useRuntimeConfig()
    const tokens = getSplitByComma(config.tokens)
    const notificationUrls = getSplitByComma(config.notificationUrls)

    const messageCollector = createMessageCollector({ notificationUrls })

    if (tokens.length === 0) {
      messageCollector.log('未配置账号，跳过签到')
      return { result: 'success' }
    }

    const storage = useStorage()
    const maxRetries = Number(config.maxRetries)

    const stats: ExecutionStats = {
      accounts: {
        total: tokens.length,
        successful: 0,
        skipped: 0,
        failed: 0,
        failedIndexes: [],
      },
      charactersByGame: new Map(),
    }

    let hasFailed = false

    const ctx = {
      stats,
      messageCollector,
      storage,
      maxRetries,
      totalAccounts: tokens.length,
    }

    await attendanceContext.call(ctx, async () => {
      for (const [index, token] of tokens.entries()) {
        const accountNumber = index + 1

        try {
          const result = await processAccount(token, accountNumber)
          if (result.accountHasError)
            hasFailed = true
        }
        catch (error) {
          const { stats, messageCollector } = useAttendanceContext()
          const errorMessage = error instanceof Error ? error.message : String(error)

          messageCollector.notify(`账号 ${accountNumber}/${tokens.length}`)
          messageCollector.infoError(`处理失败：${errorMessage}`)

          hasFailed = true
          stats.accounts.failed++
          stats.accounts.failedIndexes.push(accountNumber)
        }
      }
    })

    messageCollector.notify('签到摘要')
    messageCollector.notify(
      `账号：${stats.accounts.total} 个｜成功 ${stats.accounts.successful}｜跳过 ${stats.accounts.skipped}｜失败 ${stats.accounts.failed}`,
    )

    if (stats.accounts.failedIndexes.length > 0) {
      messageCollector.notifyError(
        `失败账号：#${stats.accounts.failedIndexes.join('、#')}`,
      )
    }

    for (const gameStats of stats.charactersByGame.values()) {
      const parts = [
        `角色 ${gameStats.total}`,
        `成功 ${gameStats.succeeded}`,
        `已签到 ${gameStats.alreadyAttended}`,
      ]

      if (gameStats.failed > 0)
        parts.push(`失败 ${gameStats.failed}`)

      messageCollector.notify(`${gameStats.gameName}：${parts.join('｜')}`)
    }

    if (stats.accounts.successful > 0 || stats.accounts.failed > 0)
      await messageCollector.push()

    return { result: hasFailed ? 'failed' : 'success' }
  },
})
