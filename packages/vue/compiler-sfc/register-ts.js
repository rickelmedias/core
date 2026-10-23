if (typeof require !== 'undefined') {
  require('@vue/compiler-sfc').registerTS(() => {
    const ts = require('typescript')
    // TypeScript 7+ only exports version metadata from its root; the compiler API
    // is in `typescript/sync` (7.1+)
    return ts.sys ? ts : require('typescript/sync')
  })
}
