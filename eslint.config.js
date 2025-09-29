import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'package-lock.json',
      'yarn.lock',
      '.env*',
      '*.config.js'
    ]
  }
]
