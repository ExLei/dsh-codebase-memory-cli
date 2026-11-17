/**
 * dsh-codebase-memory-cli — Host half.
 *
 * Wraps the **codebase-memory CLI** (a normal command-line program, not an MCP
 * server) as a small set of DSH tools.
 *
 * Two properties drive the design:
 *
 *   Index always current — every graph read re-indexes first. The CLI's `index`
 *   call is incremental, so it is the correctness boundary: a read can never use
 *   a graph older than the call that produced it, and there is no freshness
 *   heuristic to get wrong. The cost is real and measured — on a ~9.5k-node
 *   repository it is ~3.3 s whether or not anything changed, because the scan
 *   itself does not get cheaper on a clean tree. `refreshBeforeRead: false`
 *   turns it off for callers who prefer a stale answer to a slow one.
 *
 *   Partial surface — `surface: 'core'` registers the curated set only, so the
 *   tool definitions cost a fraction of the CLI's full operation catalog.
 *   `full` adds coverage, `gateway` collapses everything into one
 *   `codebase_memory` tool that catalogs the operations and forwards to them.
 *
 * The binary is a plain child process: stdout carries the JSON payload, stderr
 * carries progress and diagnostics, and a non-zero exit means failure. Two
 * command dialects are supported, because the installed binary may be either
 * the CLI-first fork or the older binary that still speaks `cli <tool>`:
 *
 *   canonical — `<exe> <command> <flags> --json`
 *   compat    — `<exe> cli --quiet <tool> <flags> --format json`
 *
 * `commandStyle: 'auto'` reads `--version` and picks; a canonical call the
 * binary rejects falls back to compat once, so the plugin keeps working across
 * an upstream switch without a settings change.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
const PLUGIN_NAME = 'codebase-memory-cli'
/** Prefix of every tool this plugin registers. */
const TOOL_PREFIX = 'codebase_'
/** The single tool contributed by `surface: 'gateway'`. */
const GATEWAY_TOOL = 'codebase_memory'
/** Default command: resolved through PATH, never a machine-specific path. */
const EXE_DEFAULT = 'codebase-memory-cli'
/** Older binary name, tried when the configured command is not on PATH. */
const EXE_LEGACY = 'codebase-memory-mcp'
/** Budget for one CLI read. */
const CALL_TIMEOUT_MS = 120000
/** Budget for one refresh re-index. */
const INDEX_TIMEOUT_MS = 600000
/** Budget for a one-shot probe (`--version`, `--help`). */
const PROBE_TIMEOUT_MS = 20000
/** How much of a failed child's stderr is quoted back. */
const STDERR_TAIL_BYTES = 2000
/** Cap on one child's captured stdout. */
const MAX_BUFFER = 96 << 20
/** Cap on a rendered payload, so one answer cannot flood the context. */
const RENDER_LIMIT_BYTES = 96 * 1024

/**
 * Operations whose input schema carries `format`, so `--format json` (compat)
 * or `--json` (canonical) returns the payload instead of a text table. The
 * remaining operations only emit their human-readable report.
 */
const FORMAT_CAPABLE = new Set([
  'list_projects',
  'index_status',
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'check_index_coverage',
  'query_graph',
  'get_file_outline',
  'get_graph_schema',
  'compare_graphs',
  'get_architecture',
  'search_code',
  'detect_changes',
])

/** Fallback catalog, used when a binary's `--help` does not list its operations. */
const KNOWN_OPERATIONS = [
  'index_repository',
  'search_graph',
  'query_graph',
  'trace_path',
  'get_code_snippet',
  'get_file_outline',
  'get_graph_schema',
  'compare_graphs',
  'get_architecture',
  'search_code',
  'list_projects',
  'delete_project',
  'index_status',
  'check_index_coverage',
  'detect_changes',
  'manage_adr',
  'ingest_traces',
]

/**
 * The curated set: discover the project, check its state, refresh it, then find,
 * read, and trace symbols. `coverage` is part of `full`.
 */
const CORE_TOOLS = ['projects', 'status', 'index', 'search', 'snippet', 'trace']
/** `core` plus the evidence-checking tool. */
const FULL_TOOLS = [...CORE_TOOLS, 'coverage']

export const name = PLUGIN_NAME

/** Services required before a tool can be registered. */
export const inject = ['tools']

/**
 * Settings-facing schema. DSH generates the form for this entry from it and
 * validates every saved value against it.
 */
export const Config = z.object({
  surface: z
    .union([z.const('core'), z.const('full'), z.const('gateway')])
    .default('core')
    .description(
      'What the model sees: core = the curated tool set (default), full = core plus codebase_coverage, gateway = one codebase_memory tool that lists every CLI operation and forwards to it.',
    ),
  expose: z
    .array(String)
    .default([])
    .description(
      'Explicit tool names for the per-tool surfaces; non-empty replaces the selected set. Accepts the short names (projects, status, index, search, snippet, trace, coverage) or the registered tool names (codebase_search, …).',
    ),
  exePath: z
    .string()
    .default(EXE_DEFAULT)
    .description(
      'CLI binary or command. The default is looked up on PATH; set an absolute path when the binary lives elsewhere. A bare default name that is not on PATH falls back to codebase-memory-mcp.',
    ),
  commandStyle: z
    .union([z.const('auto'), z.const('canonical'), z.const('compat')])
    .default('auto')
    .description(
      'How the binary is called: canonical = the CLI fork (codebase-memory-cli search … --json), compat = the older binary (codebase-memory-mcp cli search_graph … --format json), auto = read --version and decide.',
    ),
  cwd: z
    .string()
    .default('')
    .description('Working directory for CLI calls and the base for the inferred project. Empty = the Session workspace.'),
  env: z.dict(String).default({}).description('Extra environment variables for CLI calls, merged over the Host environment.'),
  defaultProject: z
    .string()
    .default('')
    .description('Project name used when a tool call omits one. Empty = infer it from the working directory through the indexed project list.'),
  refreshBeforeRead: z
    .boolean()
    .default(true)
    .description(
      'Re-index incrementally before every graph read, so an answer can never come from a stale graph. The index call scans the tree: about 3.3 s on a 9.5k-node repository, unchanged whether or not anything was edited. Off = reads use the index as it stands.',
    ),
  indexMode: z
    .union([z.const('full'), z.const('moderate'), z.const('fast')])
    .default('full')
    .description('Mode passed to a refresh re-index. full also runs semantic enrichment; fast skips it. Measured on a 9.5k-node repo, fast is not cheaper.'),
  persistence: z
    .boolean()
    .default(false)
    .description('Also write .codebase-memory/graph.db.zst beside the repository on each index. Off by default: it is rewritten on every refresh.'),
  daemon: z
    .boolean()
    .default(true)
    .description('Start the coordination daemon when the plugin loads, so the first CLI call does not pay a cold start.'),
  toolCallTimeoutMs: z.number().default(CALL_TIMEOUT_MS).description('Budget for one CLI read, in milliseconds.'),
  indexTimeoutMs: z
    .number()
    .default(INDEX_TIMEOUT_MS)
    .description('Budget for one refresh re-index, in milliseconds. A refresh that exceeds it is abandoned and the answer says the graph may be stale.'),
  enabled: z.boolean().default(true).description('Register the tools. Off spawns nothing and adds no tool.'),
})

/** Last few non-empty stderr lines, for an error message. */
function stderrTail(text) {
  const lines = String(text ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.slice(-3).join(' | ').slice(-STDERR_TAIL_BYTES)
}

/** Normalize a path for comparison: absolute, native separators, case-folded on Windows. */
function foldPath(value) {
  const resolved = path.resolve(String(value).replace(/[\\/]+/g, path.sep))
  const trimmed = resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** True when `child` is `parent` or lies inside it. */
function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

/** Resolve the settings document into concrete launch values. */
function normalize(raw) {
  const cfg = raw ?? {}
  const exePath = String(cfg.exePath ?? '').trim() || EXE_DEFAULT
  const style = String(cfg.commandStyle ?? 'auto').trim()
  const bucket = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const envRaw = cfg.env !== null && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? cfg.env : {}
  return {
    exePath,
    commandStyle: style === 'canonical' || style === 'compat' ? style : 'auto',
    cwd: String(cfg.cwd ?? '').trim(),
    env: Object.fromEntries(Object.entries(envRaw).map(([key, value]) => [String(key), String(value)])),
    surface: cfg.surface === 'full' || cfg.surface === 'gateway' ? cfg.surface : 'core',
    expose: Array.isArray(cfg.expose) ? cfg.expose.map((entry) => String(entry).trim()).filter(Boolean) : [],
    defaultProject: String(cfg.defaultProject ?? '').trim(),
    refreshBeforeRead: cfg.refreshBeforeRead !== false,
    indexMode: ['moderate', 'fast'].includes(String(cfg.indexMode ?? '').trim()) ? String(cfg.indexMode).trim() : 'full',
    persistence: cfg.persistence === true,
    daemon: cfg.daemon !== false,
    toolCallTimeoutMs: bucket(cfg.toolCallTimeoutMs, CALL_TIMEOUT_MS),
    indexTimeoutMs: bucket(cfg.indexTimeoutMs, INDEX_TIMEOUT_MS),
    enabled: cfg.enabled !== false,
  }
}

/** Every tool this plugin registers returns one text block. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/**
 * Run one child process and settle into a result object instead of rejecting.
 *
 * A non-zero exit, a timeout, and a cancellation all resolve: the callers here
 * turn those into either a downgraded answer or an error message that names the
 * command. A failure to *start* is reported through `spawnError`.
 *
 * @param command - executable or PATH name.
 * @param args - argument vector.
 * @param options - `cwd`, `env`, `timeoutMs`, `signal`.
 */
function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const settle = (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      if (error === null || error === undefined) {
        resolve({ ok: true, code: 0, stdout: out, stderr: err })
        return
      }
      resolve({
        ok: false,
        spawnError: typeof error.code === 'string',
        code: error.code,
        signal: error.signal ?? null,
        timedOut: error.killed === true,
        message: String(error.message ?? error),
        stdout: out,
        stderr: err,
      })
    }
    try {
      execFile(
        command,
        args,
        {
          ...(options?.cwd === undefined || options.cwd === '' ? {} : { cwd: options.cwd }),
          env: { ...process.env, ...(options?.env ?? {}) },
          timeout: options?.timeoutMs,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8',
          ...(options?.signal === undefined || options.signal === null ? {} : { signal: options.signal }),
        },
        settle,
      )
    } catch (error) {
      resolve({ ok: false, spawnError: true, code: 'EINVAL', stdout: '', stderr: '', message: String(error?.message ?? error) })
    }
  })
}

/** Describe a failed child as one readable clause. */
function describeFailure(result) {
  const detail = stderrTail(result.stderr)
  if (result.timedOut) return `timed out${detail === '' ? '' : `: ${detail}`}`
  if (result.spawnError) return `could not be started (${result.code ?? 'unknown'}): ${result.message}`
  if (result.signal) return `was killed by ${result.signal}${detail === '' ? '' : `: ${detail}`}`
  return `exited ${result.code}${detail === '' ? '' : `: ${detail}`}`
}

/**
 * Flatten `[flag, value]` pairs into an argument vector, dropping empty ones.
 * Arrays repeat their flag; booleans render as `true` / `false`.
 */
function flagsFrom(pairs) {
  const args = []
  for (const [name, value] of pairs) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') {
      args.push(name, value ? 'true' : 'false')
      continue
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null || String(entry).trim() === '') continue
        args.push(name, String(entry))
      }
      continue
    }
    if (String(value).trim() === '') continue
    args.push(name, String(value))
  }
  return args
}

/** Render a JSON payload, bounded so one answer cannot flood the context. */
function renderJson(payload) {
  const text = JSON.stringify(payload, null, 2) ?? 'null'
  if (text.length <= RENDER_LIMIT_BYTES) return text
  return `${text.slice(0, RENDER_LIMIT_BYTES)}\n…[rendered output cut at ${RENDER_LIMIT_BYTES} bytes; narrow the query or lower max_output_tokens]`
}

/**
 * The CLI behind one plugin instance: resolves the binary, the command dialect,
 * and executes operations.
 *
 * @param resolved - launch values from {@link normalize}.
 * @param log - `ctx.logger`.
 */
function createCli(resolved, log) {
  let exe = resolved.exePath
  let dialect = resolved.commandStyle === 'auto' ? null : resolved.commandStyle
  let banner = ''
  let probing = null
  /** Operation catalog parsed from `--help`; `null` until asked for. */
  let catalog = null

  const isBareDefault = () => !path.isAbsolute(exe) && !exe.includes('/') && !exe.includes('\\')

  /** Run one child, falling back to the legacy binary name when the default is absent. */
  const run = async (args, options) => {
    const first = await runProcess(exe, args, options)
    if (!first.spawnError || exe === EXE_LEGACY || !isBareDefault()) return first
    const second = await runProcess(EXE_LEGACY, args, options)
    if (second.spawnError) return first
    log.info(`[${PLUGIN_NAME}] "${exe}" is not available — using "${EXE_LEGACY}"`)
    exe = EXE_LEGACY
    dialect = resolved.commandStyle === 'auto' ? null : resolved.commandStyle
    return second
  }

  const probe = async () => {
    if (dialect !== null) return dialect
    if (probing !== null) return probing
    probing = (async () => {
      const result = await run(['--version'], { cwd: resolved.cwd, env: resolved.env, timeoutMs: PROBE_TIMEOUT_MS })
      const text = `${result.stdout}${result.stderr}`.trim()
      banner = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
      // The fork renames the product; the older binary reports the legacy name.
      const canonical = /\bcodebase-memory-cli\b/.test(text) && !/\bcodebase-memory-mcp\b/.test(text)
      dialect = canonical ? 'canonical' : 'compat'
      log.info(`[${PLUGIN_NAME}] ${exe} → ${banner === '' ? '(no version banner)' : banner} · ${dialect} commands`)
      return dialect
    })().finally(() => {
      probing = null
    })
    return probing
  }

  /**
   * Argument vector for one operation.
   * @param mode - `canonical` or `compat`.
   * @param command - canonical command word (`search`, `status`, …).
   * @param operation - CLI operation name (`search_graph`, …).
   * @param flags - flattened flag/value arguments.
   */
  const argvFor = (mode, command, operation, flags) => {
    const wantsJson = FORMAT_CAPABLE.has(operation)
    if (mode === 'canonical') return wantsJson ? [command, ...flags, '--json'] : [command, ...flags]
    return wantsJson ? ['cli', '--quiet', operation, ...flags, '--format', 'json'] : ['cli', '--quiet', operation, ...flags]
  }

  /** True when a failed canonical call looks like "this binary has no such command". */
  const looksUnsupported = (result) => {
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
    return (
      text.includes('unknown command') ||
      text.includes('invalid command') ||
      (text.includes('usage') && text.includes('cli <tool'))
    )
  }

  const call = async (operation, command, flags, options = {}) => {
    const mode = await probe()
    const settings = {
      cwd: options.cwd ?? resolved.cwd,
      env: resolved.env,
      timeoutMs: options.timeoutMs ?? resolved.toolCallTimeoutMs,
      signal: options.signal,
    }
    let result = await run(argvFor(mode, command, operation, flags), settings)
    if (!result.ok && mode === 'canonical' && looksUnsupported(result)) {
      log.info(`[${PLUGIN_NAME}] "${command}" is not accepted by ${exe} — switching to compat commands`)
      dialect = 'compat'
      result = await run(argvFor('compat', command, operation, flags), settings)
    }
    return result
  }

  /** Run one operation and return its parsed JSON payload. */
  const json = async (operation, command, flags, options = {}) => {
    const result = await call(operation, command, flags, options)
    if (!result.ok) throw new Error(`${operation} ${describeFailure(result)}`)
    const text = result.stdout.trim()
    if (text === '') {
      const note = stderrTail(result.stderr)
      throw new Error(`${operation} produced no output${note === '' ? '' : `: ${note}`}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      const head = text.split('\n').slice(0, 3).join(' | ').slice(0, 400)
      throw new Error(`${operation} did not return JSON — check exePath and commandStyle: ${head}`)
    }
  }

  /** Operation catalog: names from the binary's own help, with a static fallback. */
  const operations = async () => {
    if (catalog !== null) return catalog
    const result = await run(['--help'], { cwd: resolved.cwd, env: resolved.env, timeoutMs: PROBE_TIMEOUT_MS })
    const help = `${result.stdout}${result.stderr}`
    const names = []
    const block = /Tools:\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(help)
    if (block !== null) {
      for (const raw of block[1].split(/[,\n]/)) {
        const word = raw.trim()
        if (/^[a-z][a-z0-9_]*$/.test(word)) names.push(word)
      }
    }
    catalog = names.length === 0 ? KNOWN_OPERATIONS : [...new Set(names)]
    return catalog
  }

  return {
    run,
    call,
    json,
    probe,
    operations,
    argvFor,
    executable: () => exe,
    banner: () => banner,
  }
}

/**
 * @param ctx - plugin context carrying `tools`.
 * @param rawConfig - resolved `Config` values for this Loader row.
 */
export async function apply(ctx, rawConfig) {
  const resolved = normalize(rawConfig)
  if (!resolved.enabled) {
    ctx.logger.info(`[${PLUGIN_NAME}] disabled by settings — no tool was registered`)
    return
  }

  const cli = createCli(resolved, ctx.logger)
  /** The configured working directory, or '' to fall back to the Session workspace. */
  const fixedDir = path.resolve(resolved.cwd === '' ? process.cwd() : resolved.cwd)

  let disposed = false
  /** Cached `index_status` payloads; the refresh path needs `root_path` from one. */
  const statusCache = new Map()
  /** Refresh already running per project, so concurrent reads share one scan. */
  const refreshing = new Map()
  /** Cached project list. */
  let projectsCache = { at: 0, rows: [] }
  /** Daemon outcome, surfaced by the gateway's `status` action. */
  const runtime = { daemon: null, calls: 0, lastError: null }

  const nowMs = () => Date.now()
  const assertLive = () => {
    if (disposed) throw new Error('the plugin was disposed; reload it to use its tools again')
  }

  /** The Session's workspace directory, when the call context carries one. */
  const sessionCwd = (exec) => {
    const header = exec?.agent?.session?.header
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? path.resolve(cwd) : ''
  }

  /** Working directory for one call: the configured one wins, else the Session workspace. */
  const workdirOf = (exec) => (resolved.cwd === '' ? sessionCwd(exec) || fixedDir : fixedDir)

  // ── project and status lookups ────────────────────────────────────────────

  /** Project rows from `list_projects`, cached for a minute. */
  const projectRows = async (force = false, cwd = '') => {
    if (!force && nowMs() - projectsCache.at < 60000 && projectsCache.rows.length > 0) return projectsCache.rows
    const payload = await cli.json('list_projects', 'projects', [], { cwd })
    const rows = Array.isArray(payload?.projects) ? payload.projects : []
    projectsCache = { at: nowMs(), rows }
    return rows
  }

  /** Resolve the project a call applies to: explicit, configured, or inferred from the working directory. */
  const resolveProject = async (requested, cwd = '') => {
    const explicit = String(requested ?? '').trim()
    if (explicit !== '') return explicit
    if (resolved.defaultProject !== '') return resolved.defaultProject
    let rows = []
    try {
      rows = await projectRows(false, cwd)
    } catch {
      rows = []
    }
    const folded = foldPath(cwd === '' ? fixedDir : cwd)
    const inside = rows
      .filter((row) => {
        const root = String(row?.root_path ?? '').trim()
        return root !== '' && isInside(folded, foldPath(root))
      })
      .sort((left, right) => String(right.root_path).length - String(left.root_path).length)
    if (inside.length > 0) return String(inside[0].name)
    if (rows.length === 1) return String(rows[0].name)
    throw new Error(
      rows.length === 0
        ? `no project is indexed yet — call ${TOOL_PREFIX}index with the repository path first`
        : `cannot tell which project "${folded}" belongs to (${rows.length} indexed) — pass project explicitly, or set defaultProject`,
    )
  }

  /** `index_status` payload for one project, cached for a few seconds. */
  const statusOf = async (project, force = false, cwd = '') => {
    const cached = statusCache.get(project)
    if (!force && cached !== undefined && nowMs() - cached.at < 10000) return cached.payload
    const payload = await cli.json('index_status', 'status', ['--project', project], { cwd })
    statusCache.set(project, { at: nowMs(), payload })
    return payload
  }

  // ── refresh ───────────────────────────────────────────────────────────────

  /**
   * Re-index one project from its working tree.
   *
   * Concurrent readers of the same project share one run instead of queuing a
   * second scan behind the first.
   */
  const refresh = async (project, root, options) => {
    const running = refreshing.get(project)
    if (running !== undefined) {
      const outcome = await running.catch(() => null)
      return outcome === null
        ? { ok: false, note: `[index refresh failed for "${project}"; answers below may be stale]` }
        : { ok: true, note: `[index refreshed: "${project}" in ${outcome}ms — joined the run already in flight]` }
    }
    const startedAt = nowMs()
    const flags = flagsFrom([
      ['--repo-path', root],
      ['--name', project],
      ['--mode', resolved.indexMode],
      ['--persistence', resolved.persistence ? 'true' : 'false'],
    ])
    const run = (async () => {
      const result = await cli.call('index_repository', 'index', flags, {
        timeoutMs: resolved.indexTimeoutMs,
        signal: options?.signal,
        cwd: options?.cwd ?? '',
      })
      if (!result.ok) throw new Error(describeFailure(result))
      return nowMs() - startedAt
    })()
    refreshing.set(project, run)
    try {
      const durationMs = await run
      statusCache.delete(project)
      return { ok: true, note: `[index refreshed: "${project}" in ${durationMs}ms]` }
    } catch (error) {
      const detail = String(error?.message ?? error)
      runtime.lastError = detail
      return { ok: false, note: `[index refresh FAILED for "${project}": ${detail}; answers below may be stale]` }
    } finally {
      refreshing.delete(project)
    }
  }

  /**
   * The read gate: re-index, then answer. This is the whole freshness story —
   * the incremental `index` call decides what to re-extract, so nothing here has
   * to guess whether the graph is current.
   *
   * @returns the note to append to the answer, or '' when refreshing is off.
   */
  const guard = async (project, options) => {
    if (!resolved.refreshBeforeRead) return ''
    const cwd = options?.cwd ?? ''
    let root = ''
    try {
      root = String((await statusOf(project, false, cwd)).root_path ?? '').trim()
    } catch (error) {
      return `[cannot refresh "${project}": ${String(error?.message ?? error)}; the answer below may be stale]`
    }
    if (root === '') return `[cannot refresh "${project}": the index reports no root_path; the answer below may be stale]`
    return (await refresh(project, root, options)).note
  }

  /** Append a note to an answer. */
  const withNote = (body, note) => (note === '' ? body : `${body}\n${note}`)

  /** Resolve a project, refresh the graph, then one JSON operation. */
  const readGraph = async (input, exec, options) => {
    const cwd = workdirOf(exec)
    const project = await resolveProject(input?.project, cwd)
    const note = await guard(project, { signal: exec?.signal, cwd })
    const flags = flagsFrom([['--project', project], ...(options.pairs?.(input) ?? [])])
    const payload = await cli.json(options.operation, options.command, flags, { signal: exec?.signal, cwd })
    runtime.calls += 1
    return { project, payload, note }
  }

  /** Render one project row on a single line. */
  const projectLine = (row) => {
    const name = String(row?.name ?? '?')
    const root = String(row?.root_path ?? '?')
    const branch = String(row?.branch ?? '').trim()
    const counted = typeof row?.nodes === 'number' && typeof row?.edges === 'number'
    return `${name}${branch === '' ? '' : ` [${branch}]`}${counted ? ` ${row.nodes} nodes / ${row.edges} edges` : ''} ${root}`
  }

  // ── tool bodies ───────────────────────────────────────────────────────────

  const doProjects = async (input, exec) => {
    const flags = flagsFrom([
      ['--detail', input?.detail],
      ['--limit', input?.limit],
      ['--offset', input?.offset],
    ])
    const payload = await cli.json('list_projects', 'projects', flags, { signal: exec?.signal, cwd: workdirOf(exec) })
    const rows = Array.isArray(payload?.projects) ? payload.projects : []
    runtime.calls += 1
    if (rows.length === 0) return `no project is indexed yet — call ${TOOL_PREFIX}index with a repository path`
    projectsCache = { at: nowMs(), rows }
    const total = Number(payload?.total ?? rows.length)
    const more = payload?.has_more === true ? ` (more; next offset ${Number(payload?.offset ?? 0) + rows.length})` : ''
    return `${total} indexed project(s)${more}:\n${rows.map(projectLine).join('\n')}`
  }

  const doStatus = async (input, exec) => {
    const cwd = workdirOf(exec)
    const project = await resolveProject(input?.project, cwd)
    const flags = flagsFrom([
      ['--project', project],
      ['--verbose', input?.verbose === true ? true : undefined],
      ['--diagnostics', input?.diagnostics],
    ])
    const payload = await cli.json('index_status', 'status', flags, { signal: exec?.signal, cwd })
    statusCache.set(project, { at: nowMs(), payload })
    runtime.calls += 1
    const lines = [
      `project: ${String(payload?.project ?? project)}`,
      `status: ${String(payload?.status ?? '?')}`,
      `root: ${String(payload?.root_path ?? '?')}`,
      `indexed_at: ${String(payload?.indexed_at ?? '?')}`,
      `nodes: ${Number(payload?.nodes ?? 0)}  edges: ${Number(payload?.edges ?? 0)}`,
    ]
    for (const section of ['parse_partial', 'parse_unusable', 'skipped']) {
      const files = Array.isArray(payload?.[section]?.files) ? payload[section].files : []
      const count = Number(payload?.[section]?.count ?? files.length)
      if (count > 0) {
        lines.push(`${section}: ${count} file(s)${files.length === 0 ? '' : ` — ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`}`)
      }
    }
    lines.push(
      resolved.refreshBeforeRead
        ? 'note: this report is the index as it stands; every graph read re-indexes incrementally first'
        : 'note: automatic refresh is off, so reads use this index as it stands',
    )
    return lines.join('\n')
  }

  const doIndex = async (input, exec) => {
    const cwd = workdirOf(exec)
    const requested = String(input?.path ?? '').trim()
    const root = requested === '' ? cwd : path.resolve(cwd, requested)
    let project = String(input?.name ?? '').trim()
    if (project === '') {
      try {
        project = await resolveProject('', cwd)
      } catch {
        project = ''
      }
    }
    const startedAt = nowMs()
    const flags = flagsFrom([
      ['--repo-path', root],
      ['--name', project],
      ['--mode', String(input?.mode ?? resolved.indexMode)],
      ['--persistence', input?.persistence === undefined ? resolved.persistence : input.persistence === true],
    ])
    const result = await cli.call('index_repository', 'index', flags, {
      timeoutMs: resolved.indexTimeoutMs,
      signal: exec?.signal,
      cwd,
    })
    const durationMs = nowMs() - startedAt
    if (!result.ok) throw new Error(`index_repository ${describeFailure(result)}`)
    runtime.calls += 1
    statusCache.clear()
    projectsCache.at = 0
    const rows = await projectRows(true, cwd)
    const row =
      rows.find((entry) => String(entry?.name ?? '') === project) ??
      rows.find((entry) => foldPath(entry?.root_path ?? '') === foldPath(root)) ??
      rows.find((entry) => isInside(foldPath(root), foldPath(entry?.root_path ?? '\u0000')))
    if (row === undefined) return `indexed "${root}" in ${durationMs}ms; the project list reported no matching row afterwards`
    const name = String(row.name)
    statusCache.delete(name)
    const status = await statusOf(name, true, cwd)
    return [
      `indexed "${name}" in ${durationMs}ms`,
      `root: ${String(status?.root_path ?? row.root_path ?? root)}`,
      `nodes: ${Number(status?.nodes ?? 0)}  edges: ${Number(status?.edges ?? 0)}`,
      `indexed_at: ${String(status?.indexed_at ?? '?')}`,
    ].join('\n')
  }

  const doSearch = async (input, exec) => {
    const { project, payload, note } = await readGraph(input, exec, {
      operation: 'search_graph',
      command: 'search',
      pairs: (value) => [
        ['--query', value?.query],
        ['--name-pattern', value?.name_pattern],
        ['--qn-pattern', value?.qn_pattern],
        ['--label', value?.label],
        ['--kind', value?.kind],
        ['--file-pattern', value?.file_pattern],
        ['--min-degree', value?.min_degree],
        ['--include-connected', value?.include_connected],
        ['--limit', value?.limit],
        ['--offset', value?.offset],
        ['--max-output-tokens', value?.max_output_tokens],
      ],
    })
    const total = Number(payload?.total ?? 0)
    const next = Number(payload?.offset ?? 0) + Number(payload?.returned ?? 0)
    const head = `search_graph: ${total} match(es) in "${project}"${payload?.has_more === true ? ` (first ${Number(payload?.returned ?? 0)}; next offset ${next})` : ''}`
    return withNote(`${head}\n${renderJson(payload)}`, note)
  }

  const doSnippet = async (input, exec) => {
    const { payload, note } = await readGraph(input, exec, {
      operation: 'get_code_snippet',
      command: 'snippet',
      pairs: (value) => [
        ['--qualified-name', value?.qualified_name],
        ['--include-neighbors', value?.include_neighbors],
        ['--source-mode', value?.source_mode],
        ['--start-line', value?.start_line],
        ['--max-lines', value?.max_lines],
        ['--member-limit', value?.member_limit],
        ['--member-offset', value?.member_offset],
        ['--max-output-tokens', value?.max_output_tokens],
      ],
    })
    return withNote(renderJson(payload), note)
  }

  const doTrace = async (input, exec) => {
    const { project, payload, note } = await readGraph(input, exec, {
      operation: 'trace_path',
      command: 'trace',
      pairs: (value) => [
        ['--function-name', value?.function_name],
        ['--direction', value?.direction],
        ['--depth', value?.depth],
        ['--mode', value?.mode],
        ['--limit', value?.limit],
        ['--include-tests', value?.include_tests],
        ['--risk-labels', value?.risk_labels],
        ['--max-output-tokens', value?.max_output_tokens],
      ],
    })
    const counts = [
      payload?.callers_total === undefined ? '' : `callers ${payload.callers_total}`,
      payload?.callees_total === undefined ? '' : `callees ${payload.callees_total}`,
    ]
      .filter((entry) => entry !== '')
      .join(', ')
    const head = `trace_path: ${String(payload?.function ?? input?.function_name ?? '?')} in "${project}"${counts === '' ? '' : ` — ${counts}`}`
    return withNote(`${head}\n${renderJson(payload)}`, note)
  }

  const doCoverage = async (input, exec) => {
    const { payload, note } = await readGraph(input, exec, {
      operation: 'check_index_coverage',
      command: 'coverage',
      pairs: (value) => [
        ['--paths', value?.paths],
        ['--scopes', value?.scopes],
        ['--path-limit', value?.path_limit],
        ['--diagnostics', value?.diagnostics],
      ],
    })
    const rows = Array.isArray(payload?.paths) ? payload.paths : []
    const behind = rows.filter((row) => String(row?.freshness ?? '') !== 'metadata_match')
    const head =
      behind.length === 0
        ? `coverage: ${rows.length} path(s) verified against the index`
        : `coverage: ${behind.length} of ${rows.length} path(s) are not covered by the current index`
    return withNote(`${head}\n${renderJson(payload)}`, note)
  }

  // ── tool definitions ──────────────────────────────────────────────────────

  const PROJECT = {
    type: 'string',
    description: 'Indexed project name. Omit to use the project whose root contains the working directory.',
  }

  const DEFINITIONS = {
    projects: {
      name: `${TOOL_PREFIX}projects`,
      description: 'List the code graphs indexed on this machine: name, repository root, branch, and node/edge counts.',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['identity', 'stats'], description: 'identity (default) is fast; stats adds node and edge counts.' },
          limit: { type: 'integer', description: 'Rows per page, default 50.' },
          offset: { type: 'integer', description: 'Rows to skip, default 0.' },
        },
        additionalProperties: false,
      },
      run: doProjects,
    },
    status: {
      name: `${TOOL_PREFIX}status`,
      description:
        'Index state for one project: status, root, indexed_at, nodes, edges, and parse problems. It reports the index as it stands and does not refresh it.',
      parameters: {
        type: 'object',
        properties: {
          project: PROJECT,
          verbose: { type: 'boolean', description: 'Add worktree and shadow git paths for index-location debugging.' },
          diagnostics: { type: 'string', enum: ['none', 'summary', 'full'], description: 'Coverage rows: counts, five samples, or up to 500.' },
        },
        additionalProperties: false,
      },
      run: doStatus,
    },
    index: {
      name: `${TOOL_PREFIX}index`,
      description:
        'Build or refresh the code graph for a repository from its working tree. Graph reads already re-index first; call this to index a new repository or force a full rebuild.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Repository directory. Relative paths resolve from the configured working directory; omit for that directory itself.',
          },
          name: { type: 'string', description: 'Project name override. Omit to keep the existing name.' },
          mode: { type: 'string', enum: ['full', 'moderate', 'fast'], description: 'full (default) includes semantic enrichment; fast skips it.' },
          persistence: { type: 'boolean', description: 'Also write .codebase-memory/graph.db.zst beside the repository.' },
        },
        additionalProperties: false,
      },
      run: doIndex,
    },
    search: {
      name: `${TOOL_PREFIX}search`,
      description:
        'Find symbols in the code graph by text relevance, name or qualified-name pattern, node label, or resource kind. Returns qualified names, labels, files, line ranges, and in/out degrees.',
      parameters: {
        type: 'object',
        properties: {
          project: PROJECT,
          query: { type: 'string', description: 'BM25 text query.' },
          name_pattern: { type: 'string', description: 'Regular expression over the bare symbol name.' },
          qn_pattern: { type: 'string', description: 'Regular expression over the qualified name.' },
          label: { type: 'string', description: 'Exact node label, such as Function or Class.' },
          kind: { type: 'string', description: 'Resource kind, such as Deployment.' },
          file_pattern: { type: 'string', description: 'Regular expression over the repository-relative file path.' },
          min_degree: { type: 'integer', description: 'Keep symbols with at least this many call relationships.' },
          include_connected: { type: 'boolean', description: 'Expand each hit with its directly connected neighbours.' },
          limit: { type: 'integer', description: 'Rows per page, default 50.' },
          offset: { type: 'integer', description: 'Rows to skip, default 0.' },
          max_output_tokens: { type: 'integer', description: 'Size hint for the payload, default 3200.' },
        },
        additionalProperties: false,
      },
      run: doSearch,
    },
    snippet: {
      name: `${TOOL_PREFIX}snippet`,
      description:
        'Read the exact indexed source for one symbol, with the file and line range it came from — to confirm what a search or trace hit actually says.',
      parameters: {
        type: 'object',
        properties: {
          project: PROJECT,
          qualified_name: { type: 'string', description: 'Qualified name from a search or trace result, or a bare symbol name.' },
          source_mode: {
            type: 'string',
            enum: ['auto', 'full', 'outline'],
            description: 'auto (default) outlines containers over 200 lines; full returns the whole body; outline lists members only.',
          },
          start_line: { type: 'integer', description: 'First line of a partial read.' },
          max_lines: { type: 'integer', description: 'Maximum lines of a partial read.' },
          member_limit: { type: 'integer', description: 'Members per page for an outline, default 50.' },
          member_offset: { type: 'integer', description: 'Members to skip in an outline.' },
          include_neighbors: { type: 'boolean', description: "Add the symbol's callers and callees." },
          max_output_tokens: { type: 'integer', description: 'Size hint for the payload.' },
        },
        required: ['qualified_name'],
        additionalProperties: false,
      },
      run: doSnippet,
    },
    trace: {
      name: `${TOOL_PREFIX}trace`,
      description:
        'Follow call relationships from one symbol: who calls it (inbound), what it calls (outbound), or both — with hop distance and explicit totals.',
      parameters: {
        type: 'object',
        properties: {
          project: PROJECT,
          function_name: { type: 'string', description: 'Symbol name or qualified name to start from.' },
          direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'Default both.' },
          depth: { type: 'integer', description: 'Traversal depth, default 3.' },
          mode: {
            type: 'string',
            enum: ['calls', 'data_flow', 'cross_service', 'topology', 'deploy', 'run'],
            description: 'calls (default) follows CALLS edges; the others follow their own edge families.',
          },
          limit: { type: 'integer', description: 'Rows per page, default 100.' },
          include_tests: { type: 'boolean', description: 'Keep test-only callers and callees.' },
          risk_labels: { type: 'boolean', description: 'Label each hop with its risk.' },
          max_output_tokens: { type: 'integer', description: 'Size hint for the payload.' },
        },
        required: ['function_name'],
        additionalProperties: false,
      },
      run: doTrace,
    },
    coverage: {
      name: `${TOOL_PREFIX}coverage`,
      description:
        'Report whether the graph holds hash-verified evidence for specific files or scopes. Call it before relying on absence, or when a file is suspected of being unindexed.',
      parameters: {
        type: 'object',
        properties: {
          project: PROJECT,
          paths: { type: 'array', items: { type: 'string' }, description: 'Repository-relative file paths to check.' },
          scopes: { type: 'array', items: { type: 'string' }, description: 'Directory or glob scopes to check instead of single files.' },
          path_limit: { type: 'integer', description: 'Path rows to return, default 20.' },
          diagnostics: { type: 'string', enum: ['none', 'summary', 'full'], description: 'Add coverage diagnostics: counts, five samples, or up to 500 rows.' },
        },
        additionalProperties: false,
      },
      run: doCoverage,
    },
  }

  /** Resolve one `expose` entry — a definition key or a registered tool name — into a definition key. */
  const aliasOf = (entry) => {
    const value = String(entry ?? '').trim()
    if (value === '') return ''
    if (Object.hasOwn(DEFINITIONS, value)) return value
    for (const [key, definition] of Object.entries(DEFINITIONS)) {
      if (definition.name === value) return key
    }
    return value
  }

  const registered = []

  /** Register one tool definition through `ctx.effect`. */
  const register = (definition) => {
    ctx.effect(() =>
      ctx.tools.register({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: TEXT_OUTPUT,
        execute: async (input, exec) => {
          assertLive()
          try {
            return { text: await definition.run(input ?? {}, exec) }
          } catch (error) {
            runtime.lastError = String(error?.message ?? error)
            throw error
          }
        },
      }),
    )
    registered.push(definition)
  }

  // ── gateway tool ──────────────────────────────────────────────────────────

  const gatewayStatus = async () => {
    let style
    try {
      style = await cli.probe()
    } catch (error) {
      style = `unavailable: ${String(error?.message ?? error)}`
    }
    let names = []
    try {
      names = await cli.operations()
    } catch {
      names = []
    }
    return JSON.stringify(
      {
        executable: cli.executable(),
        banner: cli.banner(),
        commandStyle: style,
        surface: resolved.surface,
        refreshBeforeRead: resolved.refreshBeforeRead,
        registeredTools: registered.map((entry) => entry.name),
        operations: names,
        daemon: runtime.daemon,
        calls: runtime.calls,
        lastError: runtime.lastError,
      },
      null,
      2,
    )
  }

  /** Catalog text for the gateway: operation names, or every operation's flags. */
  const gatewayCatalog = async (detail) => {
    let names = []
    try {
      names = await cli.operations()
    } catch (error) {
      return `the CLI could not be queried: ${String(error?.message ?? error)}`
    }
    if (names.length === 0) return `no operation catalog was reported by ${cli.executable()} — check exePath`
    if (detail !== true) {
      return `${names.length} operations on ${cli.executable()}:\n${names.join(', ')}\ncall: ${GATEWAY_TOOL} {"tool":"<operation>","args":{…}}; set "detail": true for each operation's flags`
    }
    const blocks = []
    for (const entry of names) {
      const result = await cli.call(entry, entry, ['--help'], { timeoutMs: PROBE_TIMEOUT_MS })
      const lines = `${result.stdout}${result.stderr}`
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('--'))
      blocks.push(`${entry}\n${lines.length === 0 ? '  (no flags reported)' : lines.map((line) => `  ${line}`).join('\n')}`)
    }
    return `${names.length} operations on ${cli.executable()}:\n\n${blocks.join('\n\n')}`
  }

  const gatewayDispatch = async (input, exec) => {
    assertLive()
    if (String(input?.action ?? '').trim() === 'status') return gatewayStatus()
    const requested = String(input?.tool ?? '').trim()
    if (requested === '') return gatewayCatalog(input?.detail === true)
    const payload = input?.args !== null && typeof input?.args === 'object' && !Array.isArray(input.args) ? input.args : {}
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cbm-'))
    try {
      const argsFile = path.join(dir, 'args.json')
      await writeFile(argsFile, JSON.stringify(payload), 'utf8')
      const extra = FORMAT_CAPABLE.has(requested) ? ['--format', 'json'] : []
      const result = await cli.run(['cli', '--quiet', requested, '--args-file', argsFile, ...extra], {
        cwd: workdirOf(exec),
        env: resolved.env,
        timeoutMs: resolved.toolCallTimeoutMs,
        signal: exec?.signal,
      })
      runtime.calls += 1
      if (!result.ok) throw new Error(`${requested} ${describeFailure(result)}`)
      // Any operation may have written the graph.
      statusCache.clear()
      projectsCache.at = 0
      return result.stdout.trim() || '(the CLI returned no output)'
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ── startup and registration ──────────────────────────────────────────────

  /** Probe the binary, start the daemon, and warm the project list — once, off the critical path. */
  const warmed = (async () => {
    try {
      await cli.probe()
    } catch (error) {
      ctx.logger.warn(`[${PLUGIN_NAME}] could not query ${resolved.exePath}: ${String(error?.message ?? error)}`)
    }
    if (resolved.daemon) {
      try {
        const result = await cli.run(['daemon', 'start'], {
          cwd: resolved.cwd,
          env: resolved.env,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        runtime.daemon = result.ok ? result.stdout.trim() || 'started' : `failed: ${describeFailure(result)}`
        if (!result.ok) ctx.logger.info(`[${PLUGIN_NAME}] daemon start: ${runtime.daemon}`)
      } catch (error) {
        runtime.daemon = `failed: ${String(error?.message ?? error)}`
      }
    }
    try {
      await projectRows()
    } catch {
      // No indexed project yet is a normal first run; the tools report it when called.
    }
  })()

  ctx.effect(() => () => {
    disposed = true
    statusCache.clear()
    refreshing.clear()
    projectsCache = { at: 0, rows: [] }
  })

  if (resolved.surface === 'gateway') {
    register({
      name: GATEWAY_TOOL,
      description:
        'Run any operation of the local codebase-memory CLI behind one tool. Omit "tool" for the operation catalog, pass "tool" with "args" to execute one, or use "action": "status" to diagnose the binary.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'CLI operation name, such as search_graph. Omit it to get the catalog.' },
          args: {
            type: 'object',
            additionalProperties: true,
            description: "Arguments object for that operation, using the operation's own flag names as keys.",
          },
          detail: { type: 'boolean', description: "Catalog mode: list every operation's flags, not just the names." },
          action: { type: 'string', enum: ['status'], description: 'Report the resolved binary, dialect, and last error instead of calling an operation.' },
        },
        additionalProperties: false,
      },
      run: gatewayDispatch,
    })
    void warmed
    ctx.logger.info(`[${PLUGIN_NAME}] surface "gateway" — registered ${GATEWAY_TOOL}`)
    return
  }

  const keys = resolved.expose.length > 0 ? resolved.expose.map(aliasOf) : resolved.surface === 'full' ? FULL_TOOLS : CORE_TOOLS
  const unknown = keys.filter((key) => !Object.hasOwn(DEFINITIONS, key))
  if (unknown.length > 0) {
    ctx.logger.warn(
      `[${PLUGIN_NAME}] unknown name(s) in expose or surface: ${unknown.join(', ')} — available: ${Object.keys(DEFINITIONS).join(', ')}`,
    )
  }
  for (const key of keys) {
    if (Object.hasOwn(DEFINITIONS, key)) register(DEFINITIONS[key])
  }
  if (registered.length === 0) {
    ctx.logger.warn(`[${PLUGIN_NAME}] surface "${resolved.surface}" selected no tool — check expose`)
    return
  }

  void warmed
  ctx.logger.info(
    `[${PLUGIN_NAME}] surface "${resolved.surface}" — registered ${registered.length} tool(s): ${registered.map((entry) => entry.name).join(', ')}`,
  )
}
