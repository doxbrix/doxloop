import { expect, test } from 'vitest'
import { ParseError, parse } from '../src/index.js'

test('throws ParseError for empty input', () => {
  expect(() => parse('')).toThrow(ParseError)
})
