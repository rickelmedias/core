import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { normalize, resolve as resolvePath } from 'node:path'
import type { Identifier } from '@babel/types'
import { type SFCScriptCompileOptions, parse } from '../../src'
import { ScriptCompileContext } from '../../src/script/context'
import {
  inferRuntimeType,
  invalidateTypeCache,
  recordImports,
  registerTS,
  resolveTypeElements,
} from '../../src/script/resolveType'

// TypeScript 7.1, installed as `typescript-7`: the root export only has version
// metadata and the API lives in `typescript/sync` (#15997), which is what
// `vue/compiler-sfc/register-ts.js` registers for TypeScript 7+
const requireTS = createRequire(import.meta.url)
registerTS(() => requireTS('typescript-7/sync'))

describe('resolveType with the typescript/sync API', () => {
  test('ts module resolve', () => {
    const files = {
      '/node_modules/foo/package.json': JSON.stringify({
        types: 'index.d.ts',
      }),
      '/node_modules/foo/index.d.ts': 'export type P = { foo: number }',
      '/tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            bar: ['./pp.ts'],
          },
        },
      }),
      '/pp.ts': 'export type PP = { bar: string }',
    }

    const { props, deps } = resolve(
      `
      import { P } from 'foo'
      import { PP } from 'bar'
      defineProps<P & PP>()
      `,
      files,
    )

    expect(props).toStrictEqual({
      foo: ['Number'],
      bar: ['String'],
    })
    expect(deps && [...deps]).toStrictEqual([
      '/node_modules/foo/index.d.ts',
      '/pp.ts',
    ])
  })

  test('ts module resolve w/ project reference & extends', () => {
    const files = {
      '/tsconfig.json': JSON.stringify({
        references: [{ path: './tsconfig.app.json' }],
      }),
      '/tsconfig.app.json': JSON.stringify({
        include: ['**/*.ts', '**/*.vue'],
        extends: './tsconfig.web.json',
      }),
      '/tsconfig.web.json': JSON.stringify({
        compilerOptions: {
          composite: true,
          paths: {
            bar: ['./user.ts'],
          },
        },
      }),
      '/user.ts': 'export type User = { bar: string }',
    }

    const { props, deps } = resolve(
      `
      import { User } from 'bar'
      defineProps<User>()
      `,
      files,
    )

    expect(props).toStrictEqual({
      bar: ['String'],
    })
    expect(deps && [...deps]).toStrictEqual(['/user.ts'])
  })

  test('ts module resolve w/ project reference & extends & ${configDir}', () => {
    const files = {
      '/tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }],
      }),
      '/tsconfig.app.json': JSON.stringify({
        extends: ['./tsconfigs/base.json'],
      }),
      '/tsconfigs/base.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['${configDir}/src/*'],
          },
        },
        include: ['${configDir}/src/**/*.ts', '${configDir}/src/**/*.vue'],
      }),
      '/src/types.ts': 'export type BaseProps = { foo?: string, bar?: string }',
    }

    const { props, deps } = resolve(
      `
      import { BaseProps } from '@/types.ts';
      defineProps<BaseProps>()
      `,
      files,
      {},
      '/src/components/Foo.vue',
    )

    expect(props).toStrictEqual({
      foo: ['String'],
      bar: ['String'],
    })
    expect(deps && [...deps]).toStrictEqual(['/src/types.ts'])
  })

  test('ts module resolve parses a shared extended config once', () => {
    const base = '/tsconfig.base.json'
    const files: Record<string, string> = {
      '/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.a.json' },
          { path: './tsconfig.b.json' },
          { path: './tsconfig.c.json' },
        ],
      }),
      [base]: JSON.stringify({
        compilerOptions: {
          composite: true,
          paths: {
            bar: ['./user.ts'],
          },
        },
      }),
      '/user.ts': 'export type User = { bar: string }',
    }
    for (const name of ['a', 'b', 'c']) {
      files[`/tsconfig.${name}.json`] = JSON.stringify({
        extends: base,
        include: ['**/*.ts', '**/*.vue'],
      })
    }

    let baseReads = 0
    const { props } = resolve(
      `
      import { User } from 'bar'
      defineProps<User>()
      `,
      files,
      {
        fs: {
          fileExists(file) {
            return !!(files[file] ?? files[normalize(file)])
          },
          readFile(file) {
            if (normalize(file) === normalize(base)) baseReads++
            return files[file] ?? files[normalize(file)]
          },
        },
      },
    )

    expect(props).toStrictEqual({
      bar: ['String'],
    })
    expect(baseReads).toBe(1)
  })

  test('ts module resolve w/ project reference folder', () => {
    const files = {
      '/tsconfig.json': JSON.stringify({
        references: [
          { path: './web' },
          { path: './empty' },
          { path: './noexists-should-ignore' },
        ],
      }),
      '/web/tsconfig.json': JSON.stringify({
        include: ['../**/*.ts', '../**/*.vue'],
        compilerOptions: {
          composite: true,
          paths: {
            bar: ['../user.ts'],
          },
        },
      }),
      '/empty/tsconfig.json': JSON.stringify({
        compilerOptions: {
          composite: true,
        },
      }),
      '/user.ts': 'export type User = { bar: string }',
    }

    const { props, deps } = resolve(
      `
      import { User } from 'bar'
      defineProps<User>()
      `,
      files,
    )

    expect(props).toStrictEqual({
      bar: ['String'],
    })
    expect(deps && [...deps]).toStrictEqual(['/user.ts'])
  })

  test('ts module resolve circular project reference', () => {
    const files = {
      '/tsconfig.json': JSON.stringify({
        exclude: ['**/*.ts', '**/*.vue'],
        references: [{ path: './tsconfig.web.json' }],
      }),
      '/tsconfig.web.json': JSON.stringify({
        include: ['**/*.ts', '**/*.vue'],
        compilerOptions: {
          composite: true,
          paths: {
            user: ['./user.ts'],
          },
        },
        references: [{ path: './tsconfig.json' }],
      }),
      '/user.ts': 'export type User = { bar: string }',
    }

    const { props, deps } = resolve(
      `
      import { User } from 'user'
      defineProps<User>()
      `,
      files,
    )

    expect(props).toStrictEqual({
      bar: ['String'],
    })
    expect(deps && [...deps]).toStrictEqual(['/user.ts'])
  })

  test('ts module resolve w/ path aliased vue file', () => {
    const files = {
      '/tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
          },
        },
      }),
      '/src/Foo.vue':
        '<script lang="ts">export type P = { bar: string }</script>',
    }

    const { props, deps } = resolve(
      `
      import { P } from '@/Foo.vue'
      defineProps<P>()
      `,
      files,
    )

    expect(props).toStrictEqual({
      bar: ['String'],
    })
    expect(deps && [...deps]).toStrictEqual(['/src/Foo.vue'])
  })

  test('ts module resolve picks up tsconfig changes', () => {
    const files: Record<string, string> = {
      '/tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { bar: ['./a.ts'] } },
      }),
      '/a.ts': 'export type P = { a: string }',
      '/b.ts': 'export type P = { b: number }',
    }
    const code = `import { P } from 'bar'\ndefineProps<P>()`

    expect(resolve(code, files).props).toStrictEqual({ a: ['String'] })

    files['/tsconfig.json'] = JSON.stringify({
      compilerOptions: { paths: { bar: ['./b.ts'] } },
    })
    expect(resolve(code, files).props).toStrictEqual({ b: ['Number'] })
  })

  test('ts module resolve without tsconfig', () => {
    const files = {
      '/node_modules/foo/package.json': JSON.stringify({ types: 'index.d.ts' }),
      '/node_modules/foo/index.d.ts': 'export type P = { foo: number }',
    }
    for (let i = 0; i < 2; i++) {
      const { props } = resolve(
        `import { P } from 'foo'\ndefineProps<P>()`,
        files,
      )
      expect(props).toStrictEqual({ foo: ['Number'] })
    }
  })

  describe('vue/compiler-sfc/register-ts.js', () => {
    // runs the file with a stubbed `require` and returns what its loader registers
    function loadRegistered(modules: Record<string, unknown>) {
      let loader: (() => unknown) | undefined
      const source = readFileSync(
        resolvePath(__dirname, '../../../vue/compiler-sfc/register-ts.js'),
        'utf-8',
      )
      new Function('require', source)((id: string) => {
        if (id === '@vue/compiler-sfc') {
          return { registerTS: (fn: () => unknown) => (loader = fn) }
        }
        if (id in modules) return modules[id]
        throw new Error(`Cannot find module '${id}'`)
      })
      return loader!()
    }

    test('registers the classic API of TypeScript 5/6', () => {
      const classic = requireTS('typescript')
      expect(loadRegistered({ typescript: classic })).toBe(classic)
    })

    test('registers "typescript/sync" for TypeScript 7+', () => {
      const sync = requireTS('typescript-7/sync')
      expect(
        loadRegistered({
          typescript: requireTS('typescript-7'),
          'typescript/sync': sync,
        }),
      ).toBe(sync)
    })
  })

  describe('errors', () => {
    const code = `import { P } from 'foo'\ndefineProps<P>()`
    const files = {
      '/node_modules/foo/index.d.ts': 'export type P = { foo: number }',
    }

    // a fresh module, since the loaded TypeScript is kept once resolved
    async function loadResolveType() {
      vi.resetModules()
      return import('../../src/script/resolveType')
    }

    test('TypeScript 7 root export registered instead of "typescript/sync"', async () => {
      const resolveType = await loadResolveType()
      resolveType.registerTS(() => requireTS('typescript-7'))
      expect(() =>
        resolve(code, files, {}, '/Test.vue', true, resolveType),
      ).toThrow(
        'Failed to load the TypeScript 7.1.0-beta API for resolving imported types. ' +
          'TypeScript 7 provides it through "typescript/sync" (7.1 or later).',
      )
    })

    test('TypeScript 7.0, which has no "typescript/sync"', async () => {
      const resolveType = await loadResolveType()
      resolveType.registerTS(() => {
        throw new Error(`Package subpath './sync' is not defined by "exports"`)
      })
      expect(() =>
        resolve(code, files, {}, '/Test.vue', true, resolveType),
      ).toThrow('Failed to load TypeScript for resolving imported types.')
    })
  })
})

function resolve(
  code: string,
  files: Record<string, string> = {},
  options?: Partial<SFCScriptCompileOptions>,
  sourceFileName: string = '/Test.vue',
  invalidateCache = true,
  resolveType: Pick<
    typeof import('../../src/script/resolveType'),
    | 'inferRuntimeType'
    | 'invalidateTypeCache'
    | 'recordImports'
    | 'resolveTypeElements'
  > = {
    inferRuntimeType,
    invalidateTypeCache,
    recordImports,
    resolveTypeElements,
  },
) {
  const { descriptor } = parse(`<script setup lang="ts">\n${code}\n</script>`, {
    filename: sourceFileName,
  })
  const ctx = new ScriptCompileContext(descriptor, {
    id: 'test',
    fs: {
      fileExists(file) {
        return !!(files[file] ?? files[normalize(file)])
      },
      readFile(file) {
        return files[file] ?? files[normalize(file)]
      },
    },
    ...options,
  })

  if (invalidateCache) {
    for (const file in files) {
      resolveType.invalidateTypeCache(file)
    }
  }

  // ctx.userImports is collected when calling compileScript(), but we are
  // skipping that here, so need to manually register imports
  ctx.userImports = resolveType.recordImports(ctx.scriptSetupAst!.body) as any

  let target: any
  for (const s of ctx.scriptSetupAst!.body) {
    if (
      s.type === 'ExpressionStatement' &&
      s.expression.type === 'CallExpression' &&
      (s.expression.callee as Identifier).name === 'defineProps'
    ) {
      target = s.expression.typeParameters!.params[0]
    }
  }
  const raw = resolveType.resolveTypeElements(ctx, target)
  const props: Record<string, string[]> = {}
  for (const key in raw.props) {
    props[key] = resolveType.inferRuntimeType(ctx, raw.props[key])
  }
  return {
    props,
    calls: raw.calls,
    deps: ctx.deps,
    raw,
  }
}
