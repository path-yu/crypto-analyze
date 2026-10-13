/**
 * Pine 脚本落盘测试：`server/pine/<目录>/` 下同时保存 .pine 源码与 .ts 编译产物，
 * 索引落在 .cache/pine-scripts.json，并支持反向发现目录里已有的脚本。
 *
 * 通过 PINE_LIB_DIR / PINE_STORE_FILE 指向临时目录，避免污染仓库。
 *
 * 运行：pnpm exec tsx --test server/src/tests/*.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  deletePineScript,
  listPineScripts,
  savePineScript,
  slugifyScriptName,
} from '../pine/store'

let tmpRoot = ''
let libDir = ''

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-store-'))
  libDir = path.join(tmpRoot, 'pine')
  process.env.PINE_LIB_DIR = libDir
  process.env.PINE_STORE_FILE = path.join(tmpRoot, '.cache', 'pine-scripts.json')
})

after(() => {
  delete process.env.PINE_LIB_DIR
  delete process.env.PINE_STORE_FILE
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 临时目录交给系统清理 */
  }
})

const read = (dir: string, file: string) =>
  fs.readFileSync(path.join(libDir, dir, file), 'utf8')

describe('Pine 脚本落盘', () => {
  it('目录名规范化：非法字符与空白折叠，空名有兜底', () => {
    assert.equal(slugifyScriptName('Signal Suite'), 'Signal_Suite')
    assert.equal(slugifyScriptName('指标脚本 · Signal Suite'), '指标脚本_·_Signal_Suite')
    assert.equal(slugifyScriptName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i')
    assert.equal(slugifyScriptName('   '), 'pine-script')
    assert.equal(slugifyScriptName('dots...'), 'dots')
  })

  it('保存时 .pine 与 .ts 写进同一个目录，并返回相对路径', () => {
    const rec = savePineScript('落盘测试 A', '// pine source A', '// generated ts A')
    assert.ok(rec.dir, '应返回目录名')
    assert.equal(read(rec.dir as string, `${rec.dir}.pine`), '// pine source A')
    assert.equal(read(rec.dir as string, `${rec.dir}.ts`), '// generated ts A')
    assert.ok(rec.pinePath?.endsWith('.pine'), `pinePath=${rec.pinePath}`)
    assert.ok(rec.tsPath?.endsWith('.ts'), `tsPath=${rec.tsPath}`)
    assert.ok((rec.tsBytes ?? 0) > 0)
  })

  it('同名再次保存视为更新：目录不变、id 不变', () => {
    const first = savePineScript('落盘测试 B', 'v1', 'ts v1')
    const second = savePineScript('落盘测试 B', 'v2', 'ts v2')
    assert.equal(second.id, first.id)
    assert.equal(second.dir, first.dir)
    assert.equal(read(second.dir as string, `${second.dir}.pine`), 'v2')
    assert.equal(read(second.dir as string, `${second.dir}.ts`), 'ts v2')
    // 目录数不增加
    const dirs = fs.readdirSync(libDir).filter((n) => n.startsWith('落盘测试_B'))
    assert.equal(dirs.length, 1, `应只有一个目录，实际 ${dirs.join(', ')}`)
  })

  it('编译产物为空时只写 .pine，不返回 tsPath', () => {
    const rec = savePineScript('落盘测试 C', 'only source', '')
    assert.equal(rec.tsPath, undefined)
    assert.equal(rec.tsBytes, undefined)
    assert.equal(fs.existsSync(path.join(libDir, rec.dir as string, `${rec.dir}.ts`)), false)
  })

  it('列表：索引记录按更新时间倒序，且能读回源码', () => {
    const list = listPineScripts()
    const names = list.map((s) => s.name)
    assert.ok(names.includes('落盘测试 A'))
    assert.ok(names.includes('落盘测试 B'))
    const b = list.find((s) => s.name === '落盘测试 B')
    assert.equal(b?.source, 'v2')
  })

  it('反向发现：目录里已有脚本（索引没记录）也能列出', () => {
    const dir = path.join(libDir, '仓库里的脚本')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '仓库里的脚本.pine'), '// from git', 'utf8')
    fs.writeFileSync(path.join(dir, '仓库里的脚本.ts'), '// ts from git', 'utf8')

    const found = listPineScripts().find((s) => s.name === '仓库里的脚本')
    assert.ok(found, '应发现目录里的脚本')
    assert.equal(found?.id, 'dir:仓库里的脚本')
    assert.equal(found?.source, '// from git')
    assert.ok(found?.tsPath?.endsWith('仓库里的脚本.ts'))
  })

  it('目录名与既有文件冲突时自动加后缀（不覆盖内置示例）', () => {
    fs.writeFileSync(path.join(libDir, 'test.pine'), '// 内置示例', 'utf8')
    const rec = savePineScript('test.pine', '// 用户脚本', '// ts')
    assert.notEqual(rec.dir, 'test.pine')
    assert.equal(read(rec.dir as string, `${rec.dir}.pine`), '// 用户脚本')
    // 内置示例文件保持原样
    assert.equal(fs.readFileSync(path.join(libDir, 'test.pine'), 'utf8'), '// 内置示例')
  })

  it('删除：清掉 .pine/.ts 与空目录，目录里还有别的文件则保留目录', () => {
    const a = savePineScript('待删除 A', 'x', 'y')
    assert.equal(deletePineScript(a.id), true)
    assert.equal(fs.existsSync(path.join(libDir, a.dir as string)), false, '空目录应被删除')
    assert.equal(listPineScripts().some((s) => s.name === '待删除 A'), false)

    const b = savePineScript('待删除 B', 'x', 'y')
    fs.writeFileSync(path.join(libDir, b.dir as string, 'notes.md'), 'keep me', 'utf8')
    assert.equal(deletePineScript(b.id), true)
    assert.equal(fs.existsSync(path.join(libDir, b.dir as string, 'notes.md')), true, '非生成文件要保留')
    assert.equal(fs.existsSync(path.join(libDir, b.dir as string, `${b.dir}.pine`)), false)
  })

  it('删除反向发现的目录脚本：按 dir: 前缀 id 也能删', () => {
    assert.equal(deletePineScript('dir:仓库里的脚本'), true)
    assert.equal(fs.existsSync(path.join(libDir, '仓库里的脚本')), false)
  })
})
