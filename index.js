/**
 * dsh-run-button — host half.
 *
 * One script per workspace is bound in `.dsh/run-button.json`; the header
 * button launches it the same way a double-click in Explorer does, so the
 * script owns its own console window and outlives this process.
 *
 * The model only learns about the binding when the conversation is about
 * starting the project, or when a script exists but nothing is bound yet.
 */
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const inject = ['systemPrompt', 'webServer', 'workingDirectory']

const API_PREFIX = '/api/dsh-run-button'
const BINDING_PATH = path.join('.dsh', 'run-button.json')
const PROMPT_CONTEXT_NAME = 'run-button:binding'
const PROMPT_CONTEXT_ORDER = 150
const CACHE_TTL_MS = 1000
const MAX_BODY_BYTES = 64 * 1024
const SCRIPT_EXTS = new Set(['.bat', '.cmd', '.ps1', '.sh'])

/** Words that make the startup button worth mentioning to the model. */
const KEYWORDS = [
  '启动',
  '运行',
  '跑起来',
  '脚本',
  '按钮',
  '双击',
  'bat',
  'cmd',
  'ps1',
  'start',
  'launch',
  'run',
  'dev',
  'serve',
  'script',
]

export function apply(ctx) {
  /** sessionId -> { turn, hit } — the keyword gate is latched for one turn. */
  const turns = new Map()
  /** cwd -> { at, value } — prompt text must be synchronous, so state is cached. */
  const cache = new Map()
  /** sessionId -> prompt-context disposer registered on that agent's context. */
  const agents = new Map()

  const cwdOf = (agent) => {
    try {
      return ctx.workingDirectory.get(agent.session)
    } catch {
      return undefined
    }
  }

  const refresh = async (cwd, force = false) => {
    const cached = cache.get(cwd)
    if (!force && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
    const value = await computeState(cwd)
    cache.set(cwd, { at: Date.now(), value })
    return value
  }

  const promptText = (agent) => {
    const cwd = cwdOf(agent)
    if (cwd === undefined) return ''
    const value = cache.get(cwd)?.value
    if (value === undefined) return ''
    const hit = turns.get(agent.id)?.hit === true
    const guide = value.state === 'unbound' && value.candidate !== null
    if (!hit && !guide) return ''
    return promptLine(value)
  }

  const bindAgent = (agent) => {
    if (agents.has(agent.id)) return
    try {
      const dispose = agent.ctx.systemPrompt.context({
        name: PROMPT_CONTEXT_NAME,
        order: PROMPT_CONTEXT_ORDER,
        text: () => promptText(agent),
      })
      agents.set(agent.id, dispose)
    } catch (error) {
      console.warn('run-button: prompt context registration failed:', error)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    bindAgent(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    agents.get(agent.id)?.()
    agents.delete(agent.id)
    turns.delete(agent.id)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    if (agent !== undefined) {
      try {
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        const computed = messages.some((message) => mentionsStart(messageText(message)))
        const previous = turns.get(agent.id)
        const sameTurn = previous !== undefined && previous.turn === payload.turn
        turns.set(agent.id, {
          turn: payload.turn,
          hit: sameTurn ? previous.hit || computed : computed,
        })
        const cwd = cwdOf(agent)
        if (cwd !== undefined) await refresh(cwd)
      } catch {
        // A failed refresh must never block the step.
      }
    }
    return next()
  })

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/state`,
        handler: async (req, res) => {
          if (!isTrusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          const cwd = absoluteQuery(req, 'cwd')
          if (cwd === undefined) return sendJson(res, 400, { ok: false, error: 'cwd-required' })
          try {
            const value = await refresh(cwd, true)
            return sendJson(res, 200, { ok: true, ...value, debug: {
              cwd,
              binding: path.join(cwd, BINDING_PATH),
              entries: await listCandidates(cwd),
              raw: await readFile(path.join(cwd, BINDING_PATH), 'utf8').then((text) => text.slice(0, 120), (error) => `ERR ${error.code}`),
            } })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'state-failed' })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/run`,
        handler: async (req, res) => {
          if (!isTrusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            return sendJson(res, 415, { ok: false, error: 'json-required' })
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid-body' })
          }
          const cwd = typeof body?.cwd === 'string' && path.isAbsolute(body.cwd) ? body.cwd : undefined
          if (cwd === undefined) return sendJson(res, 400, { ok: false, error: 'cwd-required' })
          try {
            const value = await computeState(cwd)
            cache.set(cwd, { at: Date.now(), value })
            if (value.state !== 'ready') return sendJson(res, 409, { ok: false, error: value.state, ...value })
            const absolute = resolveScript(cwd, value.file)
            if (absolute === null) return sendJson(res, 400, { ok: false, error: 'invalid-path' })
            launch(absolute)
            return sendJson(res, 200, { ok: true, file: value.file, label: value.label })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'launch-failed' })
          }
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'run-button: http routes')

  ctx.effect(() => () => {
    for (const dispose of agents.values()) dispose()
    agents.clear()
    turns.clear()
    cache.clear()
  }, 'run-button: agent contexts')
}

async function computeState(cwd) {
  const binding = await readBinding(cwd)
  if (binding === null) {
    const candidates = await listCandidates(cwd)
    return { state: 'unbound', file: null, label: null, candidate: candidates[0] ?? null }
  }
  const absolute = resolveScript(cwd, binding.file)
  let exists = false
  if (absolute !== null) {
    try {
      exists = (await stat(absolute)).isFile()
    } catch {
      exists = false
    }
  }
  return {
    state: exists ? 'ready' : 'missing',
    file: binding.file,
    label: binding.label ?? null,
    candidate: null,
  }
}

async function readBinding(cwd) {
  let raw
  try {
    raw = await readFile(path.join(cwd, BINDING_PATH), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  let file
  let label
  if (typeof parsed === 'string') {
    file = parsed
  } else if (parsed !== null && typeof parsed === 'object') {
    if (typeof parsed.file === 'string') file = parsed.file
    if (typeof parsed.label === 'string' && parsed.label.trim() !== '') label = parsed.label.trim()
  }
  if (typeof file !== 'string' || file.trim() === '') return null
  return { file: file.trim(), label }
}

/** Resolve a bound value to an existing in-workspace path, or null. */
function resolveScript(cwd, file) {
  if (typeof file !== 'string' || file.trim() === '') return null
  const value = file.trim()
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('\\\\')) return null
  const absolute = path.resolve(cwd, value)
  const relative = path.relative(cwd, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

async function listCandidates(cwd) {
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && SCRIPT_EXTS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
  } catch {
    return []
  }
}

function rank(name) {
  const lower = name.toLowerCase()
  if (lower.includes('启动') || lower.includes('start')) return 0
  if (lower.startsWith('run')) return 1
  if (lower.includes('dev') || lower.includes('serve')) return 2
  return 3
}

function promptLine(value) {
  if (value.state === 'ready') {
    return `启动按钮 → ${value.file}（工作区根目录，点击等同双击运行）。新建或更换启动脚本后，把 .dsh/run-button.json 的 file 改成新脚本名。`
  }
  if (value.state === 'missing') {
    return `启动按钮指向的 ${value.file} 不存在；若你重建了启动脚本，请更新 .dsh/run-button.json。`
  }
  if (value.state === 'unbound' && value.candidate !== null) {
    return `启动按钮未绑定；工作区根目录有 ${value.candidate}。可把 .dsh/run-button.json 写成 {"file":"${value.candidate}"} 来绑定。`
  }
  return ''
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text + '\n'
    }
  }
  return text
}

function mentionsStart(text) {
  if (typeof text !== 'string' || text === '') return false
  const lower = text.toLowerCase()
  return KEYWORDS.some((keyword) => lower.includes(keyword))
}

/** Launch exactly like a shell association: new console window, own lifetime. */
function launch(absolutePath) {
  const cwd = path.dirname(absolutePath)
  const windows = process.platform === 'win32'
  const command = windows ? 'cmd.exe' : '/bin/sh'
  const args = windows
    ? ['/c', 'start', '', absolutePath]
    : ['-c', `exec "${absolutePath.replace(/"/g, '\\"')}"`]
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.on('error', (error) => {
    console.warn('run-button: launch failed:', error)
  })
  child.unref()
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

function absoluteQuery(req, name) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const value = url.searchParams.get(name)
    return value !== null && path.isAbsolute(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Same-origin browser request from the loopback interface only. */
function isTrusted(req) {
  const remote = String(req.socket?.remoteAddress ?? '')
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) return false
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return true
}
