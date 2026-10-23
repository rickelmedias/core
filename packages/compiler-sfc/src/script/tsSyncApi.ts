import type TS from 'typescript'
import path from 'path'
import * as process from 'process'
import { joinPaths, normalizePath } from './utils'

// TypeScript works with normalized posix-style paths on every platform
const { dirname } = path.posix || path

/**
 * The part of the `typescript/sync` module (TypeScript 7.1+) used here. Since TypeScript 7,
 * the root export (`typescript`) only carries version metadata and the compiler API runs in
 * a separate process, reached through `typescript/sync`.
 */
export interface TSSyncModule {
  API: new (options: {
    cwd?: string
    fs?: Record<string, (...args: any[]) => unknown>
  }) => TSSyncAPI
}

interface TSSyncAPI {
  readConfigFile(fileName: string): { config?: any; error?: unknown }
  parseJsonConfigFileContent(
    json: any,
    options: { configFileName: string },
  ): TS.ParsedCommandLine
  createModuleResolver(options: TS.CompilerOptions): TSModuleResolver
}

interface TSModuleResolver {
  resolveModuleName(
    moduleName: string,
    containingDirectory: string,
  ): TS.ResolvedModuleWithFailedLookupLocations
  dispose(): void
}

interface Host {
  fileExists(file: string): boolean
  readFile(file: string): string | undefined
  realpath?(file: string): string
}

// what TypeScript's `serverFS.fakeStat` derives from `fileExists`/`directoryExists`
const fileStat = { mode: 0o100644, size: 0, mtime: new Date(0) }
const directoryStat = { mode: 0o040755, size: 0, mtime: new Date(0) }

/**
 * Implements the members of the classic TypeScript API that `resolveWithTS` and
 * `loadTSConfig` use, on top of the `typescript/sync` API. Config parsing and module
 * resolution are done by TypeScript itself; it reads files through the same `fs` this
 * compiler was given, the way the classic API did.
 */
export function createTSFromSyncAPI(sync: TSSyncModule): typeof TS {
  let api: TSSyncAPI | undefined
  // API calls are synchronous, so file system callbacks always belong to the current call
  let host: Host | undefined
  // one resolver per tsconfig, replaced when that config is parsed again
  const resolvers = new Map<
    string,
    { options: TS.CompilerOptions; resolver: TSModuleResolver }
  >()

  const withHost = <T>(currentHost: Host, fn: (api: TSSyncAPI) => T): T => {
    if (!api) {
      api = new sync.API({
        cwd: process.cwd(),
        fs: {
          fileExists: (file: string) => host!.fileExists(file),
          readFile: (file: string) => host!.readFile(file),
          // like the classic resolveModuleName with a host that has no directoryExists
          directoryExists: () => true,
          // only options and references are read from parsed configs, never file lists
          getAccessibleEntries: () => ({ files: [], directories: [] }),
          realpath: (path: string) =>
            host!.realpath ? host!.realpath(path) : path,
          stat: (path: string) =>
            host!.fileExists(path) ? fileStat : directoryStat,
          writeFile: () => {},
          removeFile: () => {},
        },
      })
    }
    const previous = host
    host = currentHost
    try {
      return fn(api)
    } finally {
      host = previous
    }
  }

  const fs = require('fs') as typeof import('fs')
  const sys: Host = {
    fileExists: file =>
      fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false,
    readFile: file => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    },
    realpath: file => fs.realpathSync(file),
  }

  return {
    // `typescript/sync` exists since TypeScript 7.1 and carries no version; this lower
    // bound is only read to check `${configDir}` support (TypeScript 5.5+)
    versionMajorMinor: '7.1',
    sys,
    findConfigFile(
      searchPath: string,
      fileExists: (file: string) => boolean,
      configName = 'tsconfig.json',
    ) {
      // like the classic API: the search path itself, then each ancestor directory
      let dir = normalizePath(searchPath)
      while (true) {
        const candidate = joinPaths(dir, configName)
        if (fileExists(candidate)) return candidate
        const parent = dirname(dir)
        // `/` maps to itself, a drive root like `C:` maps to `.`
        if (parent === dir || parent === '.') return undefined
        dir = parent
      }
    },
    readConfigFile(fileName: string, readFile: Host['readFile']) {
      return withHost(
        { readFile, fileExists: file => readFile(file) !== undefined },
        api => api.readConfigFile(fileName),
      )
    },
    parseJsonConfigFileContent(
      json: any,
      configHost: Host,
      _basePath: string,
      _existingOptions: unknown,
      configFileName: string,
      _resolutionStack: unknown,
      _extraFileExtensions: unknown,
      extendedConfigCache: Map<string, unknown>,
    ) {
      // the API parses each config on its own; keep the text of configs that several of
      // them extend in the cache the caller already invalidates when a .json changes
      const cachingHost: Host = {
        ...configHost,
        readFile(file) {
          if (!file.endsWith('.json')) return configHost.readFile(file)
          const key = `sync-api:${file}`
          if (!extendedConfigCache.has(key)) {
            extendedConfigCache.set(key, configHost.readFile(file))
          }
          return extendedConfigCache.get(key) as string | undefined
        },
      }
      return withHost(cachingHost, api =>
        api.parseJsonConfigFileContent(json, { configFileName }),
      )
    },
    resolveProjectReferencePath(ref: TS.ProjectReference) {
      return ref.path.endsWith('.json')
        ? ref.path
        : joinPaths(ref.path, 'tsconfig.json')
    },
    // the API caches inside each module resolver
    createModuleResolutionCache: () => ({}),
    resolveModuleName(
      moduleName: string,
      containingFile: string,
      options: TS.CompilerOptions,
      resolveHost: Host,
    ) {
      return withHost(resolveHost, api => {
        const key = (options.configFilePath as string | undefined) || ''
        let entry = resolvers.get(key)
        // without a config the caller passes a new `{}` each time
        if (!entry || (key && entry.options !== options)) {
          entry?.resolver.dispose()
          entry = { options, resolver: api.createModuleResolver(options) }
          resolvers.set(key, entry)
        }
        return entry.resolver.resolveModuleName(
          moduleName,
          dirname(normalizePath(containingFile)),
        )
      })
    },
  } as unknown as typeof TS
}
