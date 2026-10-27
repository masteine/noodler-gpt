// Генерує тестовий файл Guitar Pro 7 (.gp) з вбудованого демо-рифу (alphaTex).
// Запуск: node --experimental-strip-types scripts/gen-fixture.mjs tests/fixtures/demo-riff.gp
import * as alphaTab from '@coderline/alphatab'
import { writeFileSync } from 'node:fs'
import { demoTex } from '../src/lib/player/demo.ts'

const settings = new alphaTab.Settings()
const importer = new alphaTab.importer.AlphaTexImporter()
importer.initFromString(demoTex, settings)
const score = importer.readScore()
const bytes = new alphaTab.exporter.Gp7Exporter().export(score, settings)
writeFileSync(process.argv[2] ?? 'tests/fixtures/demo-riff.gp', bytes)
console.log('tracks:', score.tracks.length, 'bytes:', bytes.length)
